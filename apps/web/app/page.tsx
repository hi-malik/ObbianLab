'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type Reply = {
  conversation_id: string;
  stage: string;
  message: string;
  booking_id?: string;
  booking_update?: string;
};

type KnowledgeAnswer = { answer: string; grounded: boolean; citations: { document_id: string; title: string; version: number; chunk: number }[] };

function errorText(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(item => typeof item?.msg === 'string' ? item.msg : '').filter(Boolean).join('; ') || fallback;
  return fallback;
}

type ChatLine = { from: 'you' | 'assistant'; text: string; bookingUpdate?: string };
const welcome: ChatLine = { from: 'assistant', text: "Hi, I'm Zara AI. Ask me a question, talk through an idea, or tell me what service you need. I'll ask for your confirmation before creating any booking." };

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [demo, setDemo] = useState(false);
  const [offline, setOffline] = useState(false);
  const [assessment, setAssessment] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [loginError, setLoginError] = useState('');
  useEffect(() => { fetch('/api/session').then(r => r.json()).then(s => { setAuthenticated(s.authenticated); setDemo(s.demo); setOffline(Boolean(s.offline)); setAssessment(Boolean(s.assessment)); }).catch(() => setLoginError('Unable to check your session.')); }, []);
  const [message, setMessage] = useState('');
  const [conversationId, setConversationId] = useState<string>();
  const [stage, setStage] = useState('new request');
  const [chat, setChat] = useState<ChatLine[]>([welcome]);
  const chatBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = chatBox.current;
    box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }, [chat]);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [knowledge, setKnowledge] = useState<KnowledgeAnswer>();
  const [knowledgeError, setKnowledgeError] = useState('');
  const [searching, setSearching] = useState(false);
  const bookingPending = ['awaiting confirmation', 'executing', 'failed'].includes(stage);
  function newChat() {
    if (busy || bookingPending) return;
    setConversationId(undefined); setStage('new request'); setMessage(''); setChat([welcome]);
  }

  async function searchKnowledge(event: FormEvent) {
    event.preventDefault(); if (!question.trim() || searching) return;
    setSearching(true); setKnowledgeError('');
    try {
      const response = await fetch('/api/knowledge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
      const answer = await response.json();
      if (!response.ok) throw new Error(errorText(answer.detail, 'Knowledge search failed.'));
      setKnowledge(answer);
    } catch (error) { setKnowledgeError(error instanceof Error ? error.message : 'Knowledge search failed.'); }
    finally { setSearching(false); }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    try {
      const response = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: accessToken }) });
      const body = await response.json();
      if (!response.ok) { setLoginError(errorText(body.detail, 'Sign in failed.')); return; }
      setAccessToken(''); setLoginError(''); setAuthenticated(true);
    } catch { setLoginError('Sign in is temporarily unavailable. Please retry.'); }
  }
  async function uploadAudio(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    try {
      const form = new FormData(); form.set('file', file);
      if (conversationId) form.set('conversation_id', conversationId);
      const response = await fetch('/api/voice', { method: 'POST', body: form });
      const reply = await response.json();
      if (!response.ok) throw new Error(errorText(reply.detail, 'Voice transcription unavailable.'));
      setConversationId(reply.conversation_id); setStage(reply.stage.replaceAll('_', ' '));
      setChat(current => [...current, { from: 'you', text: `Audio request: ${file.name}` }, { from: 'assistant', text: reply.message, bookingUpdate: reply.booking_update }]);
    } catch (error) { setChat(current => [...current, { from: 'assistant', text: error instanceof Error ? error.message : 'Voice request failed.' }]); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setChat((current) => [...current, { from: 'you', text }]);
    setMessage('');
    setBusy(true);
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, conversation_id: conversationId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(errorText(body.detail, 'The assistant is temporarily unavailable.'));
      const reply = body as Reply;
      setConversationId(reply.conversation_id);
      setStage(reply.stage.replaceAll('_', ' '));
      setChat((current) => [...current, { from: 'assistant', text: reply.message, bookingUpdate: reply.booking_update }]);
    } catch (error) {
      setChat((current) => [...current, { from: 'assistant', text: error instanceof Error ? error.message : 'Request failed.' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header>
        <a className="brand" href="#">obbian<span>lab</span></a>
        <div className="environment"><i />{demo ? 'local demonstration' : offline ? 'assessment demo · offline AI' : assessment ? 'assessment demo · hosted AI' : 'service platform'}</div>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">MEET ZARA AI</p>
          <h1>Let's talk.<br />Let's get it done.</h1>
          <p className="lede">Ask questions, explore ideas, or book a service with Zara AI. {offline || demo ? 'Offline booking mode is active.' : 'Powered by OpenAI GPT-4o mini.'}</p>
        </div>
        <aside>
          <span>REQUEST STATE</span>
          <strong>{stage}</strong>
          <p>The assistant cannot create a booking until you explicitly confirm the final summary.</p>
        </aside>
      </section>
      {!authenticated && <form className="signin" onSubmit={login}>
        <label htmlFor="access">Sign in with your issued access token</label>
        <div><input id="access" type="password" autoComplete="off" value={accessToken} onChange={e => setAccessToken(e.target.value)} required /><button>Sign in</button></div>
        {loginError && <p role="alert">{loginError}</p>}
      </form>}
      <section className="workspace">
        <div className="chat-toolbar"><strong>Zara AI</strong><button type="button" onClick={newChat} disabled={busy || bookingPending} title={bookingPending ? 'Resolve the current booking proposal before starting a new chat.' : 'Start a fresh conversation'}>New chat</button></div>
        <div className="chat" aria-live="polite" ref={chatBox}>
          {chat.map((line, index) => (
            <div className={`line ${line.from}`} key={`${line.from}-${index}`}>
              <small>{line.from === 'you' ? 'YOU' : 'ZARA AI'}</small>
              <p>{line.text}</p>
              {line.bookingUpdate && <div className="booking-update"><strong>Booking update</strong><p>{line.bookingUpdate}</p></div>}
            </div>
          ))}
        </div>
        <form onSubmit={submit}>
          <label htmlFor="request">Message Zara AI</label>
          <div>
            <input
              disabled={!authenticated || busy}
              id="request"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask Zara a question or describe what you need…"
              autoComplete="off"
            />
            <button disabled={busy || !authenticated}>{busy ? 'Zara is thinking…' : 'Send'}</button>
          </div>
        </form>
        <div className="voice-input"><label htmlFor="audio">Or upload a voice request</label><input id="audio" type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg" disabled={!authenticated || busy} onChange={e => { void uploadAudio(e.target.files?.[0]); e.target.value = ''; }} />
          {(demo || offline || assessment) && <small>{demo || offline ? 'Demo uses an English/Hindi parser.' : 'Hosted AI is enabled.'} Professionals and payments are simulated; voice transcription is not configured.</small>}
        </div>
      </section>
      <section className="knowledge-panel">
        <p className="eyebrow">KNOWLEDGE LIBRARY</p><h2>Answers with sources.</h2>
        <p>Search documents shared with your role. This search uses your knowledge library; use Zara's chat above for general questions.</p>
        <form onSubmit={searchKnowledge}><label htmlFor="knowledge-question">Ask a question</label><div>
          <input id="knowledge-question" value={question} onChange={e => setQuestion(e.target.value)} placeholder="What should I check before inspecting a distribution board?" disabled={!authenticated || searching} />
          <button disabled={!authenticated || searching}>{searching ? 'Searching…' : 'Search'}</button>
        </div></form>
        {knowledgeError && <p role="alert">{knowledgeError}</p>}
        {knowledge && <article aria-live="polite"><p>{knowledge.answer}</p>
          {knowledge.citations.length > 0 && <ol>{knowledge.citations.map((source, index) => <li key={`${source.document_id}-${index}`}>{source.title} · version {source.version} · passage {source.chunk + 1}</li>)}</ol>}
        </article>}
      </section>
      <footer>
        <span>Typed tool calls</span><span>Explicit confirmation</span><span>Audited actions</span>
      </footer>
    </main>
  );
}
