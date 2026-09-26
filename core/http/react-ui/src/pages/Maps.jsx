import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { API_CONFIG } from '../utils/config'
import { apiUrl } from '../utils/basePath'

export default function Maps() {
  const [maps, setMaps] = useState([])
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const context = useMemo(() => maps.map(map => map.content).join('\n\n').slice(0, 12000), [maps])

  useEffect(() => {
    fetch(apiUrl(API_CONFIG.endpoints.maps)).then(async response => {
      if (!response.ok) throw new Error('Could not load local maps')
      return response.json()
    }).then(data => setMaps(data.maps || [])).catch(err => setError(err.message))
  }, [])

  const startMapChat = () => {
    localStorage.setItem('localai_index_chat_data', JSON.stringify({
      newChat: true,
      systemPrompt: `You are the local MAPS assistant. Use this read-only memory map to orient yourself. Do not invent paths or claim access to files you cannot read.\n\n${context}`,
    }))
    navigate('/app/chat')
  }

  return <div className="page-pad maps-page">
    <div className="maps-hero"><div><span className="maps-eyebrow">Local AI operating system</span><h1>MAPS</h1><p>Memory, Agent, Pulse, Screen - all local, with the source of truth kept in your own files.</p></div><button className="btn btn-primary" onClick={startMapChat} disabled={!maps.length}><i className="fas fa-comments" /> Start map-aware chat</button></div>
    <div className="maps-layers"><article><b>M</b><span>Memory</span><small>{maps.length} local signposts</small></article><article><b>A</b><span>Agent</span><small>Map-aware LocalAI chat</small></article><article><b>P</b><span>Pulse</span><small>Local routines come next</small></article><article><b>S</b><span>Screen</span><small>Read-only dashboard</small></article></div>
    {error && <p className="maps-error">{error}</p>}
    <section className="maps-signposts"><h2>Memory signposts</h2>{maps.map(map => <details key={map.name}><summary><i className="fas fa-file-lines" /> {map.name}</summary><pre>{map.content}</pre></details>)}</section>
  </div>
}
