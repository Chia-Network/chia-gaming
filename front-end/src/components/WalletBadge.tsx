interface WalletBadgeProps {
  sessionConnected: 'connected' | 'disconnected';
}

const WalletBadge = ({ sessionConnected }: WalletBadgeProps) => {
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

    </div>
  );
};

export default WalletBadge;
