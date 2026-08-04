import { expect, test } from '@playwright/test'

test.use({ permissions: ['microphone'] })

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/sessions/voice-e2e', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'voice-e2e',
        session_id: 'voice-e2e',
        title: 'New chat',
        messages: [],
        active_turns: [],
        status: 'idle',
        preferences: {},
      }),
    })
  })

  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket

    class VoiceSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = VoiceSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor() {
        super()
        ;(window as typeof window & { __voiceSocket?: VoiceSocket }).__voiceSocket = this
        window.setTimeout(() => {
          this.readyState = VoiceSocket.OPEN
          const event = new Event('open')
          this.onopen?.(event)
          this.dispatchEvent(event)
        }, 0)
      }

      send(raw: string) {
        const message = JSON.parse(raw) as { type?: string }
        if (message.type === 'prepare') {
          this.emit({ type: 'context_ready', session_id: 'voice-e2e', source_count: 0 })
        } else if (message.type === 'start') {
          this.emit({ type: 'session_ready', session_id: 'voice-e2e' })
          this.emit({ type: 'webrtc_answer', sdp: 'mock-answer' })
          this.emit({ type: 'state', state: 'listening' })
        } else if (message.type === 'stop') {
          this.emit({ type: 'state', state: 'ended' })
        }
      }

      emit(payload: unknown) {
        const event = new MessageEvent('message', { data: JSON.stringify(payload) })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }

      close() {
        this.readyState = VoiceSocket.CLOSED
        const event = new CloseEvent('close')
        this.onclose?.(event)
        this.dispatchEvent(event)
      }
    }

    const WebSocketProxy = function (url: string | URL, protocols?: string | string[]) {
      if (String(url).includes('/api/v1/voice/realtime')) return new VoiceSocket()
      return new NativeWebSocket(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(WebSocketProxy, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    })
    window.WebSocket = WebSocketProxy

    const providerChannel = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      close() {},
    }
    class FakePeerConnection extends EventTarget {
      iceGatheringState = 'complete'
      connectionState = 'connected'
      localDescription: RTCSessionDescriptionInit | null = null
      ontrack: ((event: RTCTrackEvent) => void) | null = null
      onconnectionstatechange: (() => void) | null = null
      addTrack() {}
      createDataChannel() {
        return providerChannel
      }
      async createOffer() {
        return { type: 'offer' as const, sdp: 'mock-offer' }
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description
      }
      async setRemoteDescription() {}
      async getStats() {
        return new Map()
      }
      close() {}
    }
    window.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getAudioTracks: () => [{ enabled: true, stop() {} }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    })

    const globals = window as typeof window & {
      __emitVoiceServer?: (payload: unknown) => void
      __emitVoiceProvider?: (payload: unknown) => void
      __voiceSocket?: VoiceSocket
    }
    globals.__emitVoiceServer = payload => globals.__voiceSocket?.emit(payload)
    globals.__emitVoiceProvider = payload =>
      providerChannel.onmessage?.(
        new MessageEvent('message', { data: JSON.stringify(payload) })
      )
  })
})

test('direct GPT-Live speech renders once and provider barge-in stays provider-owned', async ({
  page,
}) => {
  await page.goto('/home/voice-e2e')
  await page.getByTestId('realtime-voice-toggle').click()
  await expect(page.getByTestId('realtime-voice-status')).toHaveText(/Listening/i)

  await page.evaluate(() => {
    const globals = window as typeof window & {
      __emitVoiceServer: (payload: unknown) => void
      __emitVoiceProvider: (payload: unknown) => void
    }
    globals.__emitVoiceServer({
      type: 'transcript',
      phase: 'final',
      mode: 'provider',
      provider_turn_id: 'user-1',
      text: 'Hello',
    })
    globals.__emitVoiceProvider({ type: 'output_audio.delta' })
    globals.__emitVoiceServer({
      type: 'assistant_transcript',
      phase: 'partial',
      text: 'Hi',
    })
    globals.__emitVoiceProvider({ type: 'input_transcript.added' })
    globals.__emitVoiceServer({
      type: 'assistant_transcript',
      phase: 'final',
      provider_turn_id: 'assistant-1',
      text: 'Hi — how can I help?',
    })
  })

  await expect(page.getByTestId('realtime-turn-mode')).toHaveAttribute('data-mode', 'provider')
  await expect(page.getByTestId('realtime-audio-output')).toHaveAttribute('data-received', 'true')
  await expect(page.getByTestId('chat-user-message')).toHaveCount(0)
  await expect(page.getByTestId('chat-assistant-message')).toHaveCount(1)
  await expect(page.getByTestId('chat-assistant-message')).toContainText('Hi — how can I help?')
  await expect(page.getByTestId('realtime-voice-status')).not.toHaveText(/Interrupted/i)

  await page.evaluate(() => {
    const globals = window as typeof window & {
      __emitVoiceServer: (payload: unknown) => void
    }
    globals.__emitVoiceServer({
      type: 'assistant_transcript',
      phase: 'final',
      provider_turn_id: 'assistant-1',
      text: 'Hi — how can I help?',
    })
  })
  await expect(page.getByTestId('chat-assistant-message')).toHaveCount(1)
})
