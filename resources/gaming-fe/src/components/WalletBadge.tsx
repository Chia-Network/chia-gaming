
import { Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

interface WalletBadgeProps {
  sessionConnected: 'connected' | 'simulator' | 'disconnected';
  fakeAddress?: string;
}

const WalletBadge = ({ sessionConnected, fakeAddress }: WalletBadgeProps) => {
  let bgColor = '';
  let textColor = '';
  let borderColor = '';
  let label = '';

  switch (sessionConnected) {
    case 'connected':
      bgColor = 'var(--color-success-bg)';
      textColor = 'var(--color-success-text)';
      borderColor = 'var(--color-success-border)';
      label = 'Connected';
      break;
    case 'simulator':
      bgColor = 'var(--color-warning-bg)';
      textColor = 'var(--color-warning-text)';
      borderColor = 'var(--color-warning-border)';
      label = 'Simulator';
      break;
    default:
      bgColor = 'var(--color-canvas-bg)';
      textColor = 'var(--color-canvas-text)';
      borderColor = 'var(--color-canvas-border)';
      label = 'Disconnected';
      break;
  }

  return (
    <div
      className="inline-flex items-center justify-center rounded-[28px] px-2 py-1 min-w-[36px] text-center font-semibold text-[0.7rem]"
      style={{
        backgroundColor: bgColor,
        color: textColor,
        border: `1px solid ${borderColor}`,
      }}
    >
      <span className="ml-0.5 text-[0.7rem] font-semibold">{label}</span>

      {fakeAddress && (
        <div className="flex items-center ml-1">
          <span className="ml-0.5 text-[0.75rem]" style={{ color: '#856404' }}>
            {`${fakeAddress.slice(0, 3)}...${fakeAddress.slice(-3)}`}
          </span>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => navigator.clipboard.writeText(fakeAddress)}
                  className="ml-1 text-[#856404] p-1 rounded hover:bg-[#8564041a] transition-colors"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="center" className="bg-[#856404] text-white text-xs px-2 py-1 rounded shadow-md select-none">
                Copy address
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </div>
  );
};

export default WalletBadge;
