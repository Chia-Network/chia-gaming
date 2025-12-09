import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';

interface WaitingScreenProps {
  stateName: string;
  messages: string[];
  cycleInterval?: number;
}

const WaitingScreen = ({ stateName, messages, cycleInterval = 2000 }: WaitingScreenProps) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (messages.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % messages.length);
    }, cycleInterval);
    return () => clearInterval(interval);
  }, [messages, cycleInterval]);

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center text-center gap-3 bg-canvas-bg-subtle text-canvas-text overflow-hidden">
      {/* Title */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
      >
        <h4
          aria-label="waiting-state"
          className="font-bold text-2xl tracking-wide text-canvas-text-contrast drop-shadow-sm"
        >
          {stateName}
        </h4>
      </motion.div>

      {/* Animated message area */}
      <div className="min-h-10 flex items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={messages[currentIndex]}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.6 }}
          >
            <p className="text-base leading-7 text-opacity-90 text-canvas-text">
              {messages[currentIndex]}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Circular Progress */}
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        className="
          w-10 h-10
          rounded-full
          border-4 border-secondary-bg-active
          border-t-transparent border-b-transparent border-l-transparent
        "
      />
    </div>
  );
};

export default WaitingScreen;
