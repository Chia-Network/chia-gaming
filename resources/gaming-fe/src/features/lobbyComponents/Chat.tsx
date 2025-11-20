import { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { ChatEnvelope } from '../../types/lobby';

interface ChatProps {
  splitPct: number;
  messagesRef: MutableRefObject<HTMLDivElement | null>;
  messages: ChatEnvelope[];
  chatInput: string;
  setChatInput: Dispatch<SetStateAction<string>>;
  handleSend: () => void;
}
export default function Chat({
  splitPct,
  messagesRef,
  messages,
  chatInput,
  setChatInput,
  handleSend,
}: ChatProps) {
  return (
    <div
      className='flex flex-col bg-canvas-bg shadow-none border-none rounded-br-xl'
      style={{ flexBasis: `${100 - splitPct}%` }}
    >
      <div className='flex flex-col h-full min-h-0 p-0'>
        {/* Lobby Chat Header */}
        <div
          className='
            flex flex-row items-center justify-between
            px-2 py-1.5 border-b border-canvas-line
          '
        >
          <h6 className='text-base font-semibold text-canvas-text-contrast'>
            Lobby Chat
          </h6>
        </div>

        <div className='border-b border-canvas-line' />

        {/* Messages */}
        <div ref={messagesRef} className='flex-1 overflow-y-auto p-2'>
          {messages.length === 0 ? (
            <p className='text-center text-canvas-text'>No messages yet.</p>
          ) : (
            messages.map((m, i) => (
              <p key={i} className='text-sm mb-1 text-canvas-text'>
                <strong>{m.alias}:</strong> {m.content.text}
              </p>
            ))
          )}
        </div>

        <div className='border-t border-canvas-line' />

        {/* Chat Input */}
        <div
          className='
            p-2 sticky bottom-0 z-20
            bg-canvas-bg border-t border-canvas-line
          '
        >
          <input
            aria-label='lobby-chat-input'
            className='
              w-full px-3 py-2 rounded bg-canvas-bg
              text-canvas-text border border-canvas-border
              outline-none
            '
            placeholder='Type your message...'
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
        </div>

        <div className='border-t border-canvas-line' />
      </div>
    </div>
  );
}
