import assert from "node:assert/strict";
import test from "node:test";

import { taiwanizeResource, toTaiwanChinese } from "@/lib/taiwan-zh";

test("Taiwan UI wording uses common local terms", () => {
  assert.equal(
    toTaiwanChinese("用户登录失败：后端服务加載數據出錯"),
    "使用者登入失敗：後端服務載入資料時發生錯誤",
  );
  assert.equal(
    toTaiwanChinese("正在基于参考考卷產生題目"),
    "正在根據參考試卷產生題目",
  );
});

test("taiwanizeResource normalizes nested locale values", () => {
  assert.deepEqual(
    taiwanizeResource({ label: "创建用户", items: ["加载失败"] }),
    { label: "建立使用者", items: ["載入失敗"] },
  );
});
