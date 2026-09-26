import { useEffect, useRef } from 'react'

function parameterCount(name) {
  const match = String(name || '').match(/(?:^|[-_ ])(\d+(?:\.\d+)?)\s*b(?:\b|[-_])/i)
  return match ? Number(match[1]) : 1
}

export default function ModelBrain({ modelName, llmName, status, active, audioRef }) {
  const canvasRef = useRef(null)
  const remoteAnalyserRef = useRef(null)
  const levelRef = useRef(0)

  const size = Math.max(parameterCount(modelName), parameterCount(llmName))
  const detail = Math.max(0, Math.min(1, Math.log10(size + 1) / Math.log10(71)))
  const nodes = Math.round(70 + detail * 210)
  const complexity = size >= 20 ? 'High-detail presence' : size >= 7 ? 'Detailed presence' : 'Lightweight presence'

  useEffect(() => {
    let context
    let timer
    const connect = () => {
      if (!context) context = new AudioContext()
      if (context.state === 'suspended') context.resume().catch(() => {})
      const audio = audioRef?.current
      if (audio?.srcObject && !remoteAnalyserRef.current) {
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = .75
        context.createMediaStreamSource(audio.srcObject).connect(analyser)
        remoteAnalyserRef.current = analyser
      }
    }
    timer = setInterval(connect, 250)
    return () => {
      clearInterval(timer)
      context?.close()
      remoteAnalyserRef.current = null
    }
  }, [active, audioRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    let frame
    const level = (analyser) => {
      if (!analyser) return 0
      const values = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(values)
      let sum = 0
      for (const value of values) { const sample = (value - 128) / 128; sum += sample * sample }
      return Math.min(1, Math.sqrt(sum / values.length) * 3.4)
    }
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const width = Math.max(1, Math.floor(rect.width * dpr))
      const height = Math.max(1, Math.floor(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      const ctx = canvas.getContext('2d')
      const w = rect.width, h = rect.height
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const incoming = level(remoteAnalyserRef.current)
      levelRef.current += (incoming - levelRef.current) * .16
      const energy = levelRef.current
      const time = performance.now() * .001
      const radius = Math.min(w, h) * (.27 + energy * .035)
      const cx = w / 2
      const cy = h / 2
      const hue = status === 'speaking' ? 30 : status === 'thinking' ? 270 : 198

      // A quiet field gives the orb a sense of depth before any of its moving
      // parts are drawn. The assistant's audio controls energy; the mic never
      // feeds this visual.
      const field = ctx.createRadialGradient(cx, cy, radius * .12, cx, cy, radius * 1.9)
      field.addColorStop(0, `hsla(${hue}, 95%, 62%, ${.12 + energy * .16})`)
      field.addColorStop(.48, `hsla(${hue + 35}, 90%, 48%, .035)`)
      field.addColorStop(1, 'transparent')
      ctx.fillStyle = field
      ctx.fillRect(0, 0, w, h)

      ctx.save()
      ctx.translate(cx, cy)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 3; i++) {
        ctx.save()
        ctx.rotate(time * (.18 + i * .07) + i * 1.04)
        ctx.scale(1, .38 + i * .12)
        ctx.setLineDash([2 + i * 2, 8 + i * 2])
        ctx.lineDashOffset = -time * (16 + i * 9)
        ctx.strokeStyle = `hsla(${hue + i * 18}, 100%, 70%, ${.16 + energy * .22})`
        ctx.lineWidth = .7 + energy * 1.1
        ctx.beginPath(); ctx.arc(0, 0, radius * (1.16 + i * .18), 0, Math.PI * 2); ctx.stroke()
        ctx.restore()
      }
      ctx.restore()
      ctx.setLineDash([])
      const points = []
      const golden = Math.PI * (3 - Math.sqrt(5))
      for (let i = 0; i < nodes; i++) {
        const y = 1 - (i / Math.max(1, nodes - 1)) * 2
        const ring = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = golden * i + time * (.16 + energy * .3)
        const depth = Math.sin(theta + time * .2) * .5 + .5
        const scale = .72 + depth * .28
        points.push({ x: cx + Math.cos(theta) * ring * radius * scale, y: cy + y * radius * scale, z: depth })
      }
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < points.length; i++) {
        const point = points[i]
        const next = points[(i + Math.max(3, Math.floor(nodes / 28))) % points.length]
        if (Math.hypot(point.x - next.x, point.y - next.y) < radius * .72) {
          ctx.strokeStyle = `hsla(${hue},90%,63%,${.08 + point.z * .16 + energy * .1})`
          ctx.lineWidth = .55 + energy
          ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(next.x, next.y); ctx.stroke()
        }
      }
      for (const point of points) {
        const dot = 1 + point.z * 1.4 + energy * 2.5
        ctx.fillStyle = `hsla(${hue + point.z * 25},100%,${67 + point.z * 20}%,${.34 + point.z * .55})`
        ctx.beginPath(); ctx.arc(point.x, point.y, dot, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      const core = ctx.createRadialGradient(cx - radius * .12, cy - radius * .16, radius * .02, cx, cy, radius * .46)
      core.addColorStop(0, `hsla(${hue + 35}, 100%, 92%, ${.8 + energy * .18})`)
      core.addColorStop(.22, `hsla(${hue}, 100%, 68%, ${.42 + energy * .32})`)
      core.addColorStop(1, `hsla(${hue}, 90%, 45%, 0)`)
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, radius * (.46 + energy * .1), 0, Math.PI * 2); ctx.fill()
      const glow = ctx.createRadialGradient(cx, cy, radius * .1, cx, cy, radius * 1.15)
      glow.addColorStop(0, `hsla(${hue},90%,65%,${.08 + energy * .18})`); glow.addColorStop(1, 'transparent')
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.2, 0, Math.PI * 2); ctx.fill()
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [nodes, status])

  const label = status === 'listening' ? 'Listening to you' : status === 'thinking' ? 'Thinking' : status === 'speaking' ? 'Speaking' : 'Ready when you are'
  const speaking = active && status === 'speaking'
  return (
    <div className="talk-brain-stage">
      <div className="talk-brain-toolbar"><div><span className="talk-brain-eyebrow">Model presence</span><p>{label}</p></div><span className="talk-brain-chip"><i className="fa-solid fa-microchip" /> {complexity}</span></div>
      <div className={`talk-brain-visual${speaking ? ' talk-brain-visual--speaking' : ''}`}>
        <div className="talk-voice-orb" aria-hidden="true">
          <span className="talk-voice-orb__aura" />
          <span className="talk-voice-orb__surface" />
          <span className="talk-voice-orb__highlight" />
        </div>
        <canvas ref={canvasRef} aria-label="Reactive model visualization" />
        <div className="talk-brain-caption"><span /> {modelName || 'Select a realtime model'}</div>
      </div>
    </div>
  )
}
