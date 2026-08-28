from __future__ import annotations

from unittest import IsolatedAsyncioTestCase

from deeptutor.services.mcp.manager import MAX_MCP_TOOL_OUTPUT_CHARS, MCPToolAdapter


class _FakeManager:
    async def call_tool(self, *_args, **_kwargs) -> str:
        return "A" * MAX_MCP_TOOL_OUTPUT_CHARS + "B" * MAX_MCP_TOOL_OUTPUT_CHARS


class MCPToolAdapterTests(IsolatedAsyncioTestCase):
    async def test_caps_oversized_tool_output(self) -> None:
        adapter = MCPToolAdapter(
            manager=_FakeManager(),  # type: ignore[arg-type]
            server_name="codebase",
            original_name="search_code",
            description="Search code",
            input_schema=None,
            tool_timeout=30,
        )

        result = await adapter.execute(pattern="goalId", project="harness-x")

        self.assertLess(len(result.content), MAX_MCP_TOOL_OUTPUT_CHARS + 500)
        self.assertTrue(result.content.startswith("A" * 100))
        self.assertTrue(result.content.endswith("B" * 100))
        self.assertIn("100,000 chars total", result.content)
        self.assertIn("Narrow the query", result.content)
        self.assertIs(result.metadata["mcp_output_truncated"], True)
        self.assertEqual(result.metadata["mcp_output_chars"], 100_000)
