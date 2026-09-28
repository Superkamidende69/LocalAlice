import { useState, useCallback, useEffect, useRef } from 'react'
import { API_CONFIG } from '../utils/config'
import { apiUrl } from '../utils/basePath'
import { effectiveSystemPrompt } from '../utils/systemPrompt'
import { useDebouncedEffect } from './useDebounce'

const thinkingTagRegex = /<thinking>([\s\S]*?)<\/thinking>|<think>([\s\S]*?)<\/think>|<\|channel>thought([\s\S]*?)<channel\|>/g
const openThinkTagRegex = /<thinking>|<think>|<\|channel>thought/
const closeThinkTagRegex = /<\/thinking>|<\/think>|<channel\|>/

async function extractHttpError(response) {
  let errorMsg = `HTTP ${response.status}`
  try {
    const errorData = await response.json()
    if (errorData.error?.message) errorMsg = errorData.error.message
  } catch (_) {}
  return errorMsg
}

// How long the UI keeps waiting for a model that is staging onto a worker.
// Staging a multi-GB checkpoint runs for tens of minutes — far longer than the
// server's own per-request wait budget — so the poll has to outlive several
// 503s. Bounded, so a load that never finishes eventually surfaces as an error
// rather than as a spinner nobody questions.
const MODEL_LOAD_POLL_INTERVAL = 3000
const MODEL_LOAD_MAX_ATTEMPTS = 3
const MODEL_LOAD_MAX_POLLS = 600 // ~30 min per attempt

// readModelLoading returns the `loading` object from the 503 the server sends
// while a model is still cold-loading, or null for any other failure. It reads
// a clone so the caller can still parse the body for its error message.
async function readModelLoading(response) {
  if (response.status !== 503) return null
  try {
    const data = await response.clone().json()
    if (data?.error?.type !== 'model_loading') return null
    return { ...(data.loading || {}), message: data.error?.message }
  } catch {
    return null
  }
}

// waitForModelReady polls load-status until the model finishes loading (404 —
// no job left), the load fails, or the caller aborts. Returns true when it is
// worth re-sending the request.
async function waitForModelReady(modelID, onProgress, signal) {
  for (let i = 0; i < MODEL_LOAD_MAX_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, MODEL_LOAD_POLL_INTERVAL))
    if (signal?.aborted) return false
    try {
      const res = await fetch(apiUrl(API_CONFIG.endpoints.modelLoadStatus(modelID)), { signal })
      if (res.status === 404) return true // job gone: loaded, or worth one retry
      if (!res.ok) return false
      const status = await res.json()
      if (status?.state === 'failed') return false
      onProgress(status)
    } catch {
      return false
    }
  }
  return false
}

// fetchWithModelLoadWait issues the request and, when the model is still
// staging onto a worker, waits for it rather than surfacing an error. The
// server answers 503 within its own wait budget so no connection is held for
// the whole load; the UI picks the wait back up here and retries once ready.
async function fetchWithModelLoadWait(url, init, modelID, onLoading, signal) {
  let response = await fetch(url, init)
  for (let attempt = 0; attempt < MODEL_LOAD_MAX_ATTEMPTS; attempt++) {
    const loading = await readModelLoading(response)
    if (!loading) return response
    onLoading(loading)
    const ready = await waitForModelReady(loading.model || modelID, onLoading, signal)
    onLoading(null)
    if (!ready) return response
    response = await fetch(url, init)
  }
  return response
}

function extractThinking(text) {
  let regularContent = ''
  let thinkingContent = ''
  let lastIdx = 0
  let match
  thinkingTagRegex.lastIndex = 0
  while ((match = thinkingTagRegex.exec(text)) !== null) {
    regularContent += text.slice(lastIdx, match.index)
    thinkingContent += match[1] || match[2] || match[3] || ''
    lastIdx = match.index + match[0].length
  }
  regularContent += text.slice(lastIdx)
  return { regularContent, thinkingContent }
}

import { generateId } from '../utils/format'

const CHATS_STORAGE_KEY = 'localai_chats_data'

function loadChats() {
  try {
    const stored = localStorage.getItem(CHATS_STORAGE_KEY)
    if (stored) {
      const data = JSON.parse(stored)
      if (data && Array.isArray(data.chats)) {
        return data
      }
    }
  } catch (_e) {
    localStorage.removeItem(CHATS_STORAGE_KEY)
  }
  return null
}

function saveChats(chats, activeChatId) {
  try {
    const data = {
      chats: chats.map(chat => ({
        ...chat,
        id: chat.id,
        name: chat.name,
        model: chat.model,
        history: chat.history,
        systemPrompt: chat.systemPrompt,
        mcpMode: chat.mcpMode,
        mcpServers: chat.mcpServers,
        clientMCPServers: chat.clientMCPServers,
        temperature: chat.temperature,
        topP: chat.topP,
        topK: chat.topK,
        tokenUsage: chat.tokenUsage,
        contextSize: chat.contextSize,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      })),
      activeChatId,
      lastSaved: Date.now(),
    }
    localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    if (err.name === 'QuotaExceededError' || err.code === 22) {
      console.warn('localStorage quota exceeded')
    }
  }
}

function createNewChat(model = '', systemPrompt = '', mcpMode = false) {
  return {
    id: generateId(),
    name: 'New Chat',
    model,
    history: [],
    systemPrompt,
    mcpMode,
    mcpServers: [],
    mcpResources: [],
    clientMCPServers: [],
    // localaiAssistant wires the chat to the in-process admin MCP server
    // exposed by /v1/chat/completions when an admin opts in.
    localaiAssistant: false,
    temperature: null,
    topP: null,
    topK: null,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    contextSize: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function useChat(initialModel = '') {
  // Keep the exact loaded snapshot around.  A streaming response must be
  // durable before React's debounced persistence runs, otherwise a refresh
  // loses every token that arrived since the last completed message.
  const [initialStored] = useState(loadChats)
  const initialStoredRef = useRef(initialStored)
  const [chats, setChatsState] = useState(() => {
    const stored = initialStoredRef.current
    if (stored && stored.chats.length > 0) return stored.chats
    return [createNewChat(initialModel)]
  })

  const [activeChatId, setActiveChatId] = useState(() => {
    const stored = initialStoredRef.current
    if (stored && stored.activeChatId) return stored.activeChatId
    return chats[0]?.id
  })

  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingChatId, setStreamingChatId] = useState(null)
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [streamingToolCalls, setStreamingToolCalls] = useState([])
  const [tokensPerSecond, setTokensPerSecond] = useState(null)
  const [maxTokensPerSecond, setMaxTokensPerSecond] = useState(null)
  // Live progress of a cold load the request is waiting on, so the composer can
  // say "staging to nvidia-thor, 41%" instead of showing an error for a model
  // that is loading exactly as it should.
  const [modelLoading, setModelLoading] = useState(null)
  const abortControllerRef = useRef(null)
  const chatsRef = useRef(chats)
  const dirtyRef = useRef(false)
  const syncBusyRef = useRef(false)
  const submittingRef = useRef(false)
  const legacyStreamingRef = useRef(false)
  const [syncError, setSyncError] = useState('')
  const setChats = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(chatsRef.current) : updater
    chatsRef.current = next
    dirtyRef.current = true
    saveChats(next, activeChatIdRef.current)
    setChatsState(next)
  }, [])
  const activeChatIdRef = useRef(activeChatId)
  const startTimeRef = useRef(null)
  const tokenCountRef = useRef(0)
  const maxTpsRef = useRef(0)
  const sharedChatsReadyRef = useRef(false)

  const activeChat = chats.find(c => c.id === activeChatId) || chats[0]

  useEffect(() => { chatsRef.current = chats }, [chats])
  useEffect(() => { activeChatIdRef.current = activeChatId }, [activeChatId])

  // Browser-only MCP tools still use the legacy stream; keep its partial text
  // without network side effects inside React's state updater.
  const saveStreamingSnapshot = useCallback((chatId, content, reasoning = '') => {
    setChats(prev => {
      const next = prev.map(chat => {
        if (chat.id !== chatId) return chat
        const partial = {
          role: 'assistant',
          content,
          reasoning: reasoning || undefined,
          inProgress: true,
          timestamp: Date.now(),
        }
        const history = [...chat.history]
        const last = history[history.length - 1]
        if (last?.inProgress) history[history.length - 1] = partial
        else history.push(partial)
        return { ...chat, history, updatedAt: Date.now() }
      })
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (syncBusyRef.current || submittingRef.current) return
      syncBusyRef.current = true
      try {
        if (dirtyRef.current && sharedChatsReadyRef.current) {
          const snapshot = chatsRef.current
          const saved = await fetch(apiUrl(API_CONFIG.endpoints.sharedChats), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chats: snapshot, activeChatId: activeChatIdRef.current, lastSaved: Date.now() }),
          })
          if (!saved.ok) throw new Error('Chat save failed; retrying.')
          if (chatsRef.current === snapshot) dirtyRef.current = false
        }
        const response = await fetch(apiUrl(API_CONFIG.endpoints.sharedChats))
        if (!response.ok) throw new Error('shared chats unavailable')
        const remote = await response.json()
        if (cancelled) return
        if (!dirtyRef.current && !submittingRef.current && !legacyStreamingRef.current && Array.isArray(remote.chats) && remote.chats.length > 0) {
          chatsRef.current = remote.chats
          setChatsState(remote.chats)
          // Active chat is a device preference; another device must not move it.
          if (!remote.chats.some(c => c.id === activeChatIdRef.current)) setActiveChatId(remote.chats[0].id)
          saveChats(remote.chats, activeChatIdRef.current)
        } else if (Array.isArray(remote.chats) && remote.chats.length === 0 && !sharedChatsReadyRef.current) {
          dirtyRef.current = true
        }
        sharedChatsReadyRef.current = true
        setSyncError('')
      } catch (_) {
        if (!cancelled) setSyncError('Reconnecting to LocalAI. Your saved response will reload when the connection returns.')
      } finally {
        syncBusyRef.current = false
      }
    }
    refresh()
    const interval = setInterval(refresh, 700)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  useDebouncedEffect(() => {
    saveChats(chats, activeChatId)
  }, [chats, activeChatId])

  const addChat = useCallback((model = '', systemPrompt = '', mcpMode = false) => {
    const chat = createNewChat(model, systemPrompt, mcpMode)
    setChats(prev => [chat, ...prev])
    setActiveChatId(chat.id)
    return chat
  }, [])

  const forkChat = useCallback((chatId, uptoIndex) => {
    const src = chats.find(c => c.id === chatId)
    if (!src) return null
    const end = typeof uptoIndex === 'number' ? uptoIndex : src.history.length
    const forked = {
      ...src,
      id: generateId(),
      name: `${src.name} (fork)`,
      history: structuredClone(src.history.slice(0, end)),
      generationId: null,
      generationStatus: null,
      generationNotice: null,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setChats(prev => [forked, ...prev])
    setActiveChatId(forked.id)
    return forked
  }, [chats])

  const switchChat = useCallback((chatId) => {
    setActiveChatId(chatId)
    setStreamingContent('')
    setStreamingReasoning('')
    setStreamingToolCalls([])
    setTokensPerSecond(null)
    setMaxTokensPerSecond(null)
  }, [])

  const deleteChat = useCallback((chatId) => {
    setChats(prev => {
      if (prev.length <= 1) return prev
      const filtered = prev.filter(c => c.id !== chatId)
      if (chatId === activeChatId && filtered.length > 0) {
        setActiveChatId(filtered[0].id)
      }
      return filtered
    })
  }, [activeChatId])

  const deleteAllChats = useCallback(() => {
    const chat = createNewChat(activeChat?.model || '')
    setChats([chat])
    setActiveChatId(chat.id)
    setStreamingContent('')
    setStreamingReasoning('')
    setStreamingToolCalls([])
    setTokensPerSecond(null)
    setMaxTokensPerSecond(null)
  }, [activeChat?.model])

  const renameChat = useCallback((chatId, name) => {
    setChats(prev => prev.map(c =>
      c.id === chatId ? { ...c, name, updatedAt: Date.now() } : c
    ))
  }, [])

  const updateChatSettings = useCallback((chatId, settings) => {
    setChats(prev => prev.map(c =>
      c.id === chatId ? { ...c, ...settings, ...(settings.history ? { generationId: null, generationStatus: null, generationNotice: null } : {}), updatedAt: Date.now() } : c
    ))
  }, [])

  const getContextUsagePercent = useCallback(() => {
    if (!activeChat || !activeChat.contextSize) return null
    return Math.min(100, ((Number(activeChat.tokenUsage?.total) || 0) / activeChat.contextSize) * 100)
  }, [activeChat])

  // Turn older conversation into a compact, factual memory.  The summary is
  // kept as a normal system message, so the existing OpenAI-compatible request
  // path continues to work with every LocalAI backend.
  const compactContext = useCallback(async (chatId) => {
    const chat = chatsRef.current.find(c => c.id === chatId)
    if (!chat?.model) throw new Error('Choose a model before compacting context.')

    const usable = chat.history.filter(message =>
      !message.inProgress && ['user', 'assistant', 'system'].includes(message.role)
    )
    if (usable.length <= 8) return false

    // Keep the most recent turns verbatim.  Those are usually the active task;
    // older turns become a concise, durable memory.
    const recent = usable.slice(-8)
    const older = usable.slice(0, -8)
    const text = older.map(message => {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
      return `${message.role.toUpperCase()}: ${content}`
    }).join('\n\n')
    // A summary request needs headroom too.  Limit the source deterministically
    // rather than allowing an already-large chat to overflow its own context.
    const maxChars = Math.max(12000, Math.min(50000, (chat.contextSize || 16000) * 2))
    const source = text.length > maxChars ? text.slice(-maxChars) : text
    const response = await fetch(apiUrl(API_CONFIG.endpoints.chatCompletions), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chat.model,
        temperature: 0.15,
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Create a compact working-memory summary of this conversation. Preserve user goals, decisions, constraints, names, paths, technical state, unresolved questions, and useful results. Do not invent facts. Write a dense summary for another assistant continuing the same task.',
          },
          { role: 'user', content: source },
        ],
      }),
    })
    if (!response.ok) throw new Error(await extractHttpError(response))
    const result = await response.json()
    const summary = result?.choices?.[0]?.message?.content?.trim()
    if (!summary) throw new Error('The model returned an empty context summary.')

    setChats(prev => prev.map(item => item.id === chatId ? {
      ...item,
      archivedHistory: [...(item.archivedHistory || []), ...older],
      generationId: null,
      generationStatus: null,
      generationNotice: null,
      history: [
        { role: 'system', content: `Conversation memory (automatically compacted):\n${summary}`, compacted: true, timestamp: Date.now() },
        ...recent,
      ],
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      updatedAt: Date.now(),
    } : item))
    return true
  }, [])

  const sendMessage = useCallback(async (content, files = [], options = {}) => {
    if (!activeChat || activeChat.generationStatus === 'running' || submittingRef.current) return

    const chatId = activeChat.id
    const model = options.model || activeChat.model
    const temperature = activeChat.temperature
    const topP = activeChat.topP
    const topK = activeChat.topK

    // Build user message content
    let messageContent
    let userFiles = []
    if (options.prebuiltContent) {
      // Caller (e.g. regenerate) already has the fully-assembled content from
      // the original send — reuse it verbatim instead of rebuilding from
      // display-only file metadata, which doesn't carry the base64/text
      // payload needed to re-embed attachments.
      messageContent = content
      userFiles = files
    } else if (files.length > 0) {
      messageContent = [{ type: 'text', text: content }]
      for (const file of files) {
        if (file.type?.startsWith('image/')) {
          messageContent.push({
            type: 'image_url',
            image_url: { url: `data:${file.type};base64,${file.base64}` },
          })
          userFiles.push({ name: file.name, type: 'image' })
        } else if (file.type?.startsWith('audio/')) {
          messageContent.push({
            type: 'audio_url',
            audio_url: { url: `data:${file.type};base64,${file.base64}` },
          })
          userFiles.push({ name: file.name, type: 'audio' })
        } else if (file.type?.startsWith('video/')) {
          messageContent.push({
            type: 'video_url',
            video_url: { url: `data:${file.type};base64,${file.base64}` },
          })
          userFiles.push({ name: file.name, type: 'video' })
        } else {
			// Text/PDF files - append to content
			if (file.textContent) {
				messageContent.push({
					type: 'text',
					text: `\n\n--- File: ${file.name} ---\n${file.textContent}\n--- End of ${file.name} ---`,
				})
			}
			userFiles.push({ name: file.name, type: 'file', content: file.textContent || '' })
		}
      }
    } else {
      messageContent = content
    }

    const userMessage = { role: 'user', content: messageContent, files: userFiles.length > 0 ? userFiles : undefined }

    // Update chat with user message
    setChats(prev => prev.map(c => {
      if (c.id !== chatId) return c
      const updated = {
        ...c,
        model,
        history: [...(options.baseHistory || c.history), userMessage],
        generationId: null,
        generationStatus: null,
        generationNotice: null,
        updatedAt: Date.now(),
      }
      if (c.history.length === 0 && typeof content === 'string') {
        updated.name = content.slice(0, 40) + (content.length > 40 ? '...' : '')
      }
      return updated
    }))

    // Build messages array for API
    const chat = chats.find(c => c.id === chatId)
    const messages = []
    // Omit empty/whitespace system prompts so the model YAML system_prompt
    // (and tokenizer chat-template defaults) are not suppressed by a blank
    // system turn from Chat Settings.
    const systemPrompt = effectiveSystemPrompt(chat?.systemPrompt)
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    // Filter out thinking/reasoning/tool_call/tool_result messages.
    // options.baseHistory lets callers (e.g. mid-conversation retry) pass the
    // intended truncated history synchronously; the closure `chat` still holds
    // the stale pre-truncation state because setChats only schedules an update.
    const baseHistory = options.baseHistory || chat?.history || []
    const historyForApi = baseHistory.filter(m =>
      !m.inProgress && m.role !== 'thinking' && m.role !== 'reasoning' && m.role !== 'tool_call' && m.role !== 'tool_result'
      && !(m.role === 'system' && !effectiveSystemPrompt(typeof m.content === 'string' ? m.content : ''))
    ).map(({ role, content, tool_calls, tool_call_id }) => ({ role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) }))
    messages.push(...historyForApi, { role: 'user', content: messageContent })

    // include_usage tells LocalAI to emit a trailing chunk with token totals;
    // without it the spec-compliant server drops `usage` from the stream and
    // the token-count badge would never populate.
    const requestBody = { model, messages, stream: true, stream_options: { include_usage: true } }
    if (temperature !== null && temperature !== undefined) requestBody.temperature = temperature
    if (topP !== null && topP !== undefined) requestBody.top_p = topP
    if (topK !== null && topK !== undefined) requestBody.top_k = topK
    // contextSize is the model's input+output window, not an
    // output cap. Backends bound generation at remaining context
    // automatically; Anthropic translate mode supplies its own
    // default. So we deliberately do not send any output-token cap.

    // MCP: send selected servers via metadata so the backend activates them
    const hasMcpServers = activeChat.mcpServers && activeChat.mcpServers.length > 0
    if (hasMcpServers) {
      if (!requestBody.metadata) requestBody.metadata = {}
      requestBody.metadata.mcp_servers = activeChat.mcpServers.join(',')
    }

    // MCP: send selected resource URIs via metadata
    const hasMcpResources = activeChat.mcpResources && activeChat.mcpResources.length > 0
    if (hasMcpResources) {
      if (!requestBody.metadata) requestBody.metadata = {}
      requestBody.metadata.mcp_resources = activeChat.mcpResources.join(',')
    }

    // LocalAI Assistant: opt this chat session into the in-process admin
    // MCP server. The backend gates on admin role; the toggle is hidden
    // for non-admins, but defense-in-depth still applies on the server.
    if (activeChat.localaiAssistant) {
      if (!requestBody.metadata) requestBody.metadata = {}
      requestBody.metadata.localai_assistant = 'true'
    }

    // Client-side MCP: inject tools into request body
    if (options.clientMCPTools && options.clientMCPTools.length > 0) {
      requestBody.tools = [...(requestBody.tools || []), ...options.clientMCPTools]
    }

    // Use MCP endpoint only for legacy mcpMode without specific servers selected
    // (the MCP endpoint auto-enables all servers)
    const endpoint = (activeChat.mcpMode && !hasMcpServers)
      ? API_CONFIG.endpoints.mcpChatCompletions
      : API_CONFIG.endpoints.chatCompletions

    // Normal chats and server MCP tools are owned by LocalAI. The UI only
    // polls saved snapshots, so unmount/reload does not cancel inference.
    if (!options.clientMCPTools?.length) {
      submittingRef.current = true
      const id = generateId()
      const snapshot = chatsRef.current.find(c => c.id === chatId)
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, generationId: id, generationStatus: 'running' } : c))
      try {
        const payload = JSON.stringify({ id, chat: snapshot, endpoint, request: requestBody })
        // The same request ID makes retries safe if only the acknowledgement
        // is lost; it cannot trigger a duplicate generation.
        let response
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await fetch(apiUrl('/api/chats/generate'), {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
            })
            break
          } catch (error) {
            if (attempt === 2) throw error
            await new Promise(resolve => setTimeout(resolve, 700))
          }
        }
        if (!response.ok) throw new Error(await extractHttpError(response))
        // A GET now recovers the authoritative job, including if the page
        // disappears before its first token or before this POST resolves.
        dirtyRef.current = false
      } catch (error) {
        setChats(prev => prev.map(c => c.id === chatId ? { ...c, generationStatus: 'failed', generationNotice: `Could not confirm generation: ${error.message}. Reconnecting checks for saved output.` } : c))
        dirtyRef.current = false
      } finally {
        submittingRef.current = false
      }
      return
    }

    const controller = new AbortController()
    legacyStreamingRef.current = true
    abortControllerRef.current = controller
    setIsStreaming(true)
    setStreamingChatId(activeChatId)
    setStreamingContent('')
    setStreamingReasoning('')
    setStreamingToolCalls([])
    setTokensPerSecond(null)
    setMaxTokensPerSecond(null)
    startTimeRef.current = Date.now()
    tokenCountRef.current = 0
    maxTpsRef.current = 0

    let usage = {}
    const newMessages = [] // Accumulate messages to add to history

    if (activeChat.mcpMode && !hasMcpServers) {
      // Legacy MCP SSE streaming (custom event types from /v1/mcp/chat/completions)
      try {
        const timeoutId = setTimeout(() => controller.abort(), 300000) // 5 min timeout
        const response = await fetchWithModelLoadWait(apiUrl(endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }, requestBody.model, setModelLoading, controller.signal)
        clearTimeout(timeoutId)

        if (!response.ok) {
          throw new Error(await extractHttpError(response))
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        let assistantContent = ''
        let reasoningContent = ''
        let hasReasoningFromAPI = false
        let currentToolCalls = []

        while (true) {
          const { value, done } = await reader.read()
          if (done) break

          buffer += value
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.trim() || line.startsWith(':')) continue
            if (line === 'data: [DONE]') continue
            if (!line.startsWith('data: ')) continue

            try {
              const eventData = JSON.parse(line.slice(6))

              switch (eventData.type) {
                case 'reasoning':
                  hasReasoningFromAPI = true
                  if (eventData.content) {
                    reasoningContent += eventData.content
                    tokenCountRef.current += Math.ceil(eventData.content.length / 4)
                    setStreamingReasoning(reasoningContent)
                    updateTps()
                  }
                  break

                case 'tool_call':
                  if (eventData.name) {
                    const tc = {
                      type: 'tool_call',
                      name: eventData.name,
                      arguments: eventData.arguments || {},
                      reasoning: eventData.reasoning || '',
                    }
                    currentToolCalls.push(tc)
                    setStreamingToolCalls([...currentToolCalls])
                    newMessages.push({ role: 'tool_call', content: JSON.stringify(tc, null, 2), expanded: false })
                  }
                  break

                case 'tool_result':
                  if (eventData.name) {
                    const tr = {
                      type: 'tool_result',
                      name: eventData.name,
                      result: eventData.result || '',
                    }
                    currentToolCalls.push(tr)
                    setStreamingToolCalls([...currentToolCalls])
                    newMessages.push({ role: 'tool_result', content: JSON.stringify(tr, null, 2), expanded: false })
                  }
                  break

                case 'status':
                  // Logged but not displayed
                  break

                case 'assistant':
                  if (eventData.content) {
                    assistantContent += eventData.content
                    tokenCountRef.current += Math.ceil(eventData.content.length / 4)
                    // Handle thinking tags if no API reasoning
                    if (!hasReasoningFromAPI) {
                      const { regularContent, thinkingContent } = extractThinking(assistantContent)
                      if (thinkingContent) {
                        reasoningContent = thinkingContent
                        setStreamingReasoning(reasoningContent)
                      }
                      setStreamingContent(regularContent)
                    } else {
                      setStreamingContent(assistantContent)
                    }
                    const { regularContent: savedContent } = extractThinking(assistantContent)
                    saveStreamingSnapshot(chatId, savedContent || assistantContent, reasoningContent)
                    updateTps()
                  }
                  break

                case 'error':
                  newMessages.push({ role: 'assistant', content: `Error: ${eventData.message || eventData.error?.message || 'Unknown error'}` })
                  break
              }
            } catch (_e) {
              // skip malformed JSON
            }
          }
        }

        // Final: add accumulated messages
        let finalContent = assistantContent
        if (!hasReasoningFromAPI) {
          const { regularContent, thinkingContent } = extractThinking(assistantContent)
          finalContent = regularContent
          if (thinkingContent && !reasoningContent) reasoningContent = thinkingContent
        }

        if (reasoningContent) {
          newMessages.unshift({ role: 'thinking', content: reasoningContent, expanded: true })
        }
        if (finalContent) {
          newMessages.push({ role: 'assistant', content: finalContent })
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          newMessages.push({ role: 'assistant', content: `Error: ${err.message}` })
        }
      }
    } else {
      // Regular SSE streaming with client-side agentic loop support
      const maxToolTurns = options.maxToolTurns || 10
      let turnCount = 0
      let loopMessages = [...messages]
      let loopBody = { ...requestBody }

      // Outer loop: re-sends when client-side tool calls are detected
      let continueLoop = true
      while (continueLoop) {
        continueLoop = false

        let rawContent = ''
        let reasoningContent = ''
        let hasReasoningFromAPI = false
        let insideThinkTag = false
        let currentToolCalls = []
        let finishReason = null
        let fullToolCalls = [] // Tool calls with id for agentic loop

        try {
          const response = await fetchWithModelLoadWait(apiUrl(endpoint), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(loopBody),
            signal: controller.signal,
          }, loopBody.model, setModelLoading, controller.signal)

          if (!response.ok) {
            throw new Error(await extractHttpError(response))
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data: ')) continue
              const data = trimmed.slice(6)
              if (data === '[DONE]') continue

              try {
                const parsed = JSON.parse(data)

                // Handle structured error events
                if (parsed.error) {
                  const errMsg = typeof parsed.error === 'string'
                    ? parsed.error
                    : parsed.error.message || 'Unknown error'
                  rawContent += `\n\nError: ${errMsg}`
                  setStreamingContent(rawContent)
                  saveStreamingSnapshot(chatId, rawContent, reasoningContent)
                  continue
                }

                // Handle MCP tool result events
                if (parsed?.type === 'mcp_tool_result') {
                  currentToolCalls.push({
                    type: 'tool_result',
                    name: parsed.name || 'tool',
                    result: parsed.result || '',
                  })
                  setStreamingToolCalls([...currentToolCalls.filter(Boolean)])
                  continue
                }

                const choice = parsed?.choices?.[0]
                const delta = choice?.delta

                // Track finish_reason
                if (choice?.finish_reason) {
                  finishReason = choice.finish_reason
                }

                // Handle reasoning field from API
                if (delta?.reasoning) {
                  hasReasoningFromAPI = true
                  reasoningContent += delta.reasoning
                  tokenCountRef.current++
                  setStreamingReasoning(reasoningContent)
                  updateTps()
                }

                // Handle tool call deltas
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0
                    if (!currentToolCalls[idx]) {
                      currentToolCalls[idx] = {
                        type: 'tool_call',
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      }
                      fullToolCalls[idx] = {
                        id: tc.id || `call_${idx}`,
                        type: 'function',
                        function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
                      }
                    } else {
                      if (tc.function?.name) {
                        currentToolCalls[idx].name = tc.function.name
                        fullToolCalls[idx].function.name = tc.function.name
                      }
                      if (tc.function?.arguments) {
                        currentToolCalls[idx].arguments += tc.function.arguments
                        fullToolCalls[idx].function.arguments += tc.function.arguments
                      }
                      if (tc.id) fullToolCalls[idx].id = tc.id
                    }
                  }
                  setStreamingToolCalls([...currentToolCalls.filter(Boolean)])
                }

                if (delta?.content) {
                  rawContent += delta.content
                  tokenCountRef.current++

                  if (!hasReasoningFromAPI) {
                    if (openThinkTagRegex.test(rawContent) && !closeThinkTagRegex.test(rawContent)) {
                      insideThinkTag = true
                    }
                    if (insideThinkTag && closeThinkTagRegex.test(rawContent)) {
                      insideThinkTag = false
                    }

                    const { regularContent, thinkingContent } = extractThinking(rawContent)
                    if (thinkingContent) {
                      reasoningContent = thinkingContent
                    }

                    if (insideThinkTag) {
                      const lastOpen = Math.max(rawContent.lastIndexOf('<thinking>'), rawContent.lastIndexOf('<think>'), rawContent.lastIndexOf('<|channel>thought'))
                      if (lastOpen >= 0) {
                        const partial = rawContent.slice(lastOpen).replace(/<thinking>|<think>|<\|channel>thought/, '')
                        setStreamingReasoning(partial)
                        const beforeThink = rawContent.slice(0, lastOpen)
                        const { regularContent: contentBeforeThink } = extractThinking(beforeThink)
                        setStreamingContent(contentBeforeThink)
                      } else {
                        setStreamingContent(regularContent)
                      }
                    } else {
                      setStreamingReasoning(reasoningContent)
                      setStreamingContent(regularContent)
                    }
                  } else {
                    setStreamingContent(rawContent)
                  }

                  const { regularContent: savedContent } = extractThinking(rawContent)
                  saveStreamingSnapshot(chatId, savedContent || rawContent, reasoningContent)
                  updateTps()
                }
                if (parsed?.usage) {
                  usage = parsed.usage
                }
              } catch (_e) {
                // skip malformed JSON
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            rawContent += `\n\nError: ${err.message}`
          }
        }

        // Client-side agentic loop: check for client tool calls
        const validToolCalls = fullToolCalls.filter(Boolean)
        const hasClientToolCalls = (
          (finishReason === 'tool_calls' || finishReason === 'stop' && validToolCalls.length > 0) &&
          validToolCalls.length > 0 &&
          options.isClientTool &&
          options.executeTool &&
          turnCount < maxToolTurns
        )

        const clientCalls = hasClientToolCalls
          ? validToolCalls.filter(tc => options.isClientTool(tc.function?.name))
          : []

        if (clientCalls.length > 0) {
          // Add tool calls to streaming display
          for (const tc of clientCalls) {
            newMessages.push({
              role: 'tool_call',
              content: JSON.stringify({ type: 'tool_call', name: tc.function.name, arguments: tc.function.arguments }, null, 2),
              expanded: false,
            })
          }

          // Build assistant message with tool_calls for conversation
          const assistantMsg = {
            role: 'assistant',
            content: rawContent || null,
            tool_calls: validToolCalls,
          }
          loopMessages.push(assistantMsg)

          // Execute each client-side tool
          for (const tc of clientCalls) {
            const result = await options.executeTool(tc.function.name, tc.function.arguments)
            const toolResultMsg = { role: 'tool', tool_call_id: tc.id, content: result }
            loopMessages.push(toolResultMsg)

            // Check for MCP App UI
            let appUI = null
            if (options.getToolAppUI) {
              let parsedArgs
              try {
                parsedArgs = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments) : tc.function.arguments
              } catch (_) { parsedArgs = {} }
              appUI = await options.getToolAppUI(tc.function.name, parsedArgs, result)
            }

            // Show result in UI
            newMessages.push({
              role: 'tool_result',
              content: JSON.stringify({ type: 'tool_result', name: tc.function.name, result }, null, 2),
              expanded: false,
              appUI,
            })
            currentToolCalls.push({ type: 'tool_result', name: tc.function.name, result, appUI })
            setStreamingToolCalls([...currentToolCalls.filter(Boolean)])
          }

          // Re-send with updated messages
          loopBody = { ...requestBody, messages: loopMessages, stream: true }
          setStreamingContent('')
          turnCount++
          continueLoop = true
          continue
        }

        // No more client tool calls — finalize
        let finalContent = rawContent
        if (!hasReasoningFromAPI) {
          const { regularContent, thinkingContent } = extractThinking(rawContent)
          finalContent = regularContent
          if (thinkingContent && !reasoningContent) reasoningContent = thinkingContent
        }

        if (reasoningContent) {
          newMessages.push({ role: 'thinking', content: reasoningContent, expanded: true })
        }
        if (finalContent) {
          newMessages.push({ role: 'assistant', content: finalContent })
        }
      }
    }

    // Finalize
    legacyStreamingRef.current = false
    setIsStreaming(false)
    setStreamingChatId(null)
    setModelLoading(null)
    abortControllerRef.current = null
    setStreamingContent('')
    setStreamingReasoning('')
    setStreamingToolCalls([])

    // Set max tokens/sec badge
    if (maxTpsRef.current > 0) {
      setMaxTokensPerSecond(Math.round(maxTpsRef.current * 10) / 10)
    }

    // Add messages to history
    if (newMessages.length > 0) {
      setChats(prev => prev.map(c => {
        if (c.id !== chatId) return c
        return {
          ...c,
          // A streaming snapshot is a durable placeholder.  Replace it with
          // the completed turn instead of leaving a duplicate assistant reply.
          history: [...c.history.filter(message => !message.inProgress), ...newMessages],
          tokenUsage: {
            prompt: usage.prompt_tokens || c.tokenUsage.prompt,
            completion: usage.completion_tokens || c.tokenUsage.completion,
            total: usage.total_tokens || c.tokenUsage.total,
          },
          updatedAt: Date.now(),
        }
      }))
    }
  }, [activeChat, chats, saveStreamingSnapshot])

  function updateTps() {
    const elapsed = (Date.now() - startTimeRef.current) / 1000
    if (elapsed > 0) {
      const tps = tokenCountRef.current / elapsed
      setTokensPerSecond(Math.round(tps * 10) / 10)
      if (tps > maxTpsRef.current) {
        maxTpsRef.current = tps
      }
    }
  }

  const stopGeneration = useCallback(() => {
    if (activeChat?.generationStatus === 'running') {
      fetch(apiUrl(`/api/chats/generations/${encodeURIComponent(activeChat.generationId)}/cancel`), { method: 'POST' })
        .then(response => { if (!response.ok) throw new Error('Stop request failed') })
        .catch(error => setSyncError(error.message))
      return
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }, [activeChat?.generationId, activeChat?.generationStatus])

  const clearHistory = useCallback((chatId) => {
    setChats(prev => prev.map(c =>
      c.id === chatId ? { ...c, history: [], generationId: null, generationStatus: null, generationNotice: null, tokenUsage: { prompt: 0, completion: 0, total: 0 }, updatedAt: Date.now() } : c
    ))
  }, [])

  const isActiveStreaming = isStreaming && streamingChatId === activeChatId

  const addMessage = useCallback((chatId, message) => {
    setChats(prev => prev.map(c => {
      if (c.id !== chatId) return c
      return {
        ...c,
        history: [...c.history, { ...message, timestamp: Date.now() }],
        updatedAt: Date.now(),
      }
    }))
  }, [])

  return {
    chats,
    activeChat,
    activeChatId,
    isStreaming: isActiveStreaming || activeChat?.generationStatus === 'running',
    streamingChatId: isStreaming ? streamingChatId : chats.find(c => c.generationStatus === 'running')?.id,
    syncError,
    streamingContent: isActiveStreaming ? streamingContent : '',
    streamingReasoning: isActiveStreaming ? streamingReasoning : '',
    streamingToolCalls: isActiveStreaming ? streamingToolCalls : [],
    tokensPerSecond,
    maxTokensPerSecond,
    modelLoading: isActiveStreaming ? modelLoading : null,
    addChat,
    forkChat,
    switchChat,
    deleteChat,
    deleteAllChats,
    renameChat,
    updateChatSettings,
    sendMessage,
    stopGeneration,
    clearHistory,
    compactContext,
    getContextUsagePercent,
    addMessage,
  }
}
