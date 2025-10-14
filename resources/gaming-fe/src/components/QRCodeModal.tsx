import { ContentCopy, Close, CheckCircle, QrCode2, Smartphone } from '@mui/icons-material';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
  CircularProgress,
  Alert,
  IconButton,
  useTheme,
  useMediaQuery,
  Fade,
  Paper,
} from '@mui/material';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface QRCodeModalProps {
  open: boolean;
  uri: string | undefined;
  onClose: () => void;
}

export function QRCodeModal({ open, uri, onClose }: QRCodeModalProps) {
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  useEffect(() => {
    if (uri && open) {
      setIsGenerating(true);
      setError('');

      QRCode.toDataURL(uri, {
        width: isMobile ? 250 : 300,
        margin: 2,
        color: {
          dark: theme.palette.mode === 'dark' ? '#FFFFFF' : '#000000',
          light: theme.palette.mode === 'dark' ? '#121212' : '#FFFFFF',
        },
        errorCorrectionLevel: 'M',
      })
        .then((dataUrl) => {
          setQrCodeDataUrl(dataUrl);
          setIsGenerating(false);
        })
        .catch((err) => {
          console.error('Error generating QR code:', err);
          setError('Failed to generate QR code');
          setIsGenerating(false);
        });
    }
  }, [uri, open, isMobile, theme.palette.mode]);

  const copyToClipboard = async () => {
    if (!uri) return;
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy URI:', err);
      setError('Failed to copy to clipboard');
    }
  };

  const handleClose = () => {
    setCopied(false);
    setError('');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      fullScreen={isMobile}
      PaperProps={{
        sx: {
          borderRadius: isMobile ? 0 : 2,
          background:
            theme.palette.mode === 'dark'
              ? 'linear-gradient(145deg, #1a1a1a 0%, #2d2d2d 100%)'
              : 'linear-gradient(145deg, #ffffff 0%, #f8f9fa 100%)',
          boxShadow: theme.palette.mode === 'dark' ? '0 8px 32px rgba(0, 0, 0, 0.4)' : '0 8px 32px rgba(0, 0, 0, 0.1)',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          pb: 1,
          background:
            theme.palette.mode === 'dark'
              ? 'linear-gradient(90deg, #1a1a1a 0%, #2d2d2d 100%)'
              : 'linear-gradient(90deg, #f8f9fa 0%, #ffffff 100%)',
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <QrCode2 sx={{ color: theme.palette.primary.main }} />
          <Typography variant="h6" component="div">
            Connect to Chia Wallet
          </Typography>
        </Box>
        <IconButton onClick={handleClose} size="small">
          <Close />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 3 }}>
        <Box sx={{ textAlign: 'center' }}>
          {/* Instructions */}
          <Box sx={{ mb: 3 }}>
            <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
              Scan QR Code
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Open your Chia wallet and scan this QR code to connect securely
            </Typography>

            {/* Mobile hint */}
            {isMobile && (
              <Alert icon={<Smartphone />} severity="info" sx={{ mb: 2, textAlign: 'left' }}>
                On mobile, you can also copy the connection URI below
              </Alert>
            )}
          </Box>

          {/* QR Code */}
          <Paper
            elevation={3}
            sx={{
              p: 3,
              mb: 3,
              display: 'inline-block',
              background: '#ffffff',
              borderRadius: 2,
              border: `2px solid ${theme.palette.divider}`,
            }}
          >
            {isGenerating ? (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                  minHeight: isMobile ? 250 : 300,
                  justifyContent: 'center',
                }}
              >
                <CircularProgress size={40} />
                <Typography variant="body2" color="text.secondary">
                  Generating QR Code...
                </Typography>
              </Box>
            ) : error ? (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                  minHeight: isMobile ? 250 : 300,
                  justifyContent: 'center',
                }}
              >
                <Typography variant="body2" color="error">
                  {error}
                </Typography>
                <Button variant="outlined" onClick={() => window.location.reload()} size="small">
                  Retry
                </Button>
              </Box>
            ) : (
              <Fade in={!!qrCodeDataUrl} timeout={500}>
                <img
                  src={qrCodeDataUrl}
                  alt="WalletConnect QR Code"
                  style={{
                    maxWidth: '100%',
                    height: 'auto',
                    borderRadius: 8,
                  }}
                />
              </Fade>
            )}
          </Paper>

          {/* Connection URI */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
              Connection URI
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Or copy this URI to connect manually:
            </Typography>

            <TextField
              fullWidth
              multiline
              rows={isMobile ? 4 : 3}
              value={uri || ''}
              variant="outlined"
              size="small"
              InputProps={{
                readOnly: true,
                sx: {
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                },
              }}
              sx={{
                mb: 2,
                '& .MuiOutlinedInput-root': {
                  backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.02)',
                },
              }}
            />
          </Box>

          {/* Success message */}
          {copied && (
            <Fade in={copied} timeout={300}>
              <Alert icon={<CheckCircle />} severity="success" sx={{ mb: 2 }}>
                URI copied to clipboard!
              </Alert>
            </Fade>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ p: 3, pt: 0 }}>
        <Button
          onClick={copyToClipboard}
          variant="outlined"
          startIcon={<ContentCopy />}
          disabled={!uri}
          sx={{ minWidth: 120 }}
        >
          Copy URI
        </Button>
        <Button onClick={handleClose} variant="contained" sx={{ minWidth: 100 }}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
