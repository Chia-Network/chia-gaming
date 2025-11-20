import { Box, Typography, CircularProgress } from '@mui/material';
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
    <Box
      sx={{
        height: '100vh',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-canvas-bg-subtle)',
        color: 'var(--color-canvas-text)',
        textAlign: 'center',
        gap: 3,
        overflow: 'hidden',
      }}
    >
      {/* Title */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
      >
        <Typography
          variant="h4"
          fontWeight={700}
          sx={{
            letterSpacing: '0.5px',
            textShadow: '0 1px 4px rgba(0,0,0,0.04)',
            color: 'var(--color-canvas-text-contrast)',
          }}
          aria-label="waiting-state"
        >
          {stateName}
        </Typography>
      </motion.div>

      {/* Animated message area */}
      <Box sx={{ minHeight: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={messages[currentIndex]}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.6 }}
          >
            <Typography
              variant="body1"
              sx={{
                opacity: 0.9,
                fontSize: '1rem',
                lineHeight: 1.8,
                color: 'var(--color-canvas-text)',
              }}
            >
              {messages[currentIndex]}
            </Typography>
          </motion.div>
        </AnimatePresence>
      </Box>

      {/* Circular Progress */}
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
          <CircularProgress
            size={60}
            thickness={4}
            sx={{
              color: 'var(--color-canvas-solid)',
              // small glow using the same solid color with reduced opacity
              filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.04))',
            }}
          />
        </Box>
      </motion.div>
    </Box>
  );
};

export default WaitingScreen;
