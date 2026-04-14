import { useEffect, useRef, useState } from 'react';
import { ChatMessage } from '../types/ChiaGaming';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  myAlias: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const ChatPanel: React.FC<ChatPanelProps> = ({ messages, onSend, myAlias }) => {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className='flex flex-col h-full'>
      {/* Message list */}
      <div
        ref={scrollRef}
        className='flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2'
      >
        {messages.length === 0 && (
          <p className='text-center text-canvas-solid text-sm pt-8'>
            No messages yet. Say hello!
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col ${msg.isMine ? 'items-end' : 'items-start'}`}
          >
            <span className='text-[10px] text-canvas-solid mb-0.5 px-1'>
              {msg.fromAlias} · {formatTime(msg.timestamp)}
            </span>
            <div
              className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm break-words ${
                msg.isMine
                  ? 'bg-primary-solid text-primary-on-primary rounded-br-sm'
                  : 'bg-canvas-bg border border-canvas-line text-canvas-text rounded-bl-sm'
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
      </div>

      {/* Input area */}
      <div className='flex-shrink-0 border-t border-canvas-line px-4 py-2 flex gap-2 items-end bg-canvas-bg-subtle'>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Type a message…'
          rows={1}
          className='flex-1 resize-none rounded-md border border-canvas-border bg-canvas-bg px-3 py-1.5 text-sm text-canvas-text placeholder:text-canvas-solid focus:outline-none focus:ring-1 focus:ring-primary-border'
        />
        <button
          onClick={handleSend}
          disabled={!draft.trim()}
          className='flex-shrink-0 px-3 py-1.5 rounded-md text-sm font-medium bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;
