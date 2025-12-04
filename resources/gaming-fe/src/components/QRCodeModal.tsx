
import { CircularProgress, useMediaQuery, useTheme } from '@mui/material';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './button';
import { Close } from '@radix-ui/react-dialog';
import { CheckCircle, Copy, QrCode, Smartphone } from 'lucide-react';

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
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={`
             ${isMobile
            ? "w-full max-w-full rounded-none p-0 pt-16"
            : "w-full max-w-xl rounded-2xl p-0"
          }
            border border-canvas-border bg-canvas-bg shadow-xl
            overflow-hidden
          `}
      >
        {/* HEADER */}
        <DialogHeader
          className="
        flex flex-row items-center justify-between
        px-4 py-3 border-b border-canvas-line
        bg-canvas-bg-subtle
      "
        >
          <div className="flex items-center gap-2">
            <QrCode className="text-primary-text" />
            <DialogTitle className="text-lg font-semibold text-canvas-text-contrast">
              Connect to Chia Wallet
            </DialogTitle>
          </div>

          <DialogClose asChild>
            <button className="p-1 rounded hover:bg-canvas-bg-hover transition">
              <Close className="w-5 h-5 text-canvas-text" />
            </button>
          </DialogClose>
        </DialogHeader>

        {/* BODY */}
        <div className="p-6 text-center">
          {/* Instructions */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-1 text-canvas-text-contrast">
              Scan QR Code
            </h3>
            <p className="text-sm mb-3 text-canvas-text">
              Open your Chia wallet and scan this QR code to connect securely
            </p>

            {isMobile && (
              <Alert className="text-left mb-4 bg-info-bg border-info-border">
                <Smartphone className="w-4 h-4 text-info-text" />
                <AlertTitle>Mobile</AlertTitle>
                <AlertDescription>
                  On mobile, you can also copy the connection URI below
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* QR CODE */}
          <div
            className="
          w-full max-w-[220px] mx-auto p-4 mb-6 rounded-xl border-2 border-canvas-border bg-white shadow-md

        "
          >
            {isGenerating ? (
              <div className="flex flex-col items-center gap-3 min-h-[300px] justify-center">
                <CircularProgress size={40} />
                <p className="text-sm text-secondary-text">
                  Generating QR Code...
                </p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-3 min-h-[300px] justify-center">
                <p className="text-sm text-alert-text">
                  {error}
                </p>
                <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                  Retry
                </Button>
              </div>
            ) : (
              <img
                src={qrCodeDataUrl}
                className="w-full max-w-[200px] mx-auto h-auto rounded-md transition-opacity"
              />
            )}
          </div>

          {/* URI TEXTFIELD */}
          <div className="mb-6 text-left">
            <p className="text-sm font-semibold mb-1 text-canvas-text-contrast">
              Connection URI
            </p>
            <p className="text-xs mb-2 text-canvas-text">
              Or copy this URI to connect manually:
            </p>

            <textarea
              readOnly
              value={uri || ""}
              rows={isMobile ? 4 : 3}
              className="
            w-full text-sm font-mono rounded-md p-2 border
            border-canvas-border bg-canvas-bg-subtle
            text-canvas-text resize-none
          "
            />
          </div>

          {/* COPY SUCCESS */}
          {copied && (
            <Alert className="mb-2 bg-success-bg border-success-border">
              <CheckCircle className="w-4 h-4 text-success-text" />
              <AlertDescription>URI copied to clipboard!</AlertDescription>
            </Alert>
          )}
        </div>

        {/* FOOTER */}
        <DialogFooter className="flex flex-row items-center justify-end gap-2 p-4">

          <Button
            variant="outline"
            onClick={copyToClipboard}
            disabled={!uri}
            className="min-w-[120px] border-primary-border text-primary-text"
          >
            <Copy className="w-4 h-4 mr-1" />
            Copy URI
          </Button>

          <DialogClose asChild>
            <Button className="min-w-[100px] bg-primary-bg text-primary-text-contrast hover:bg-primary-bg-hover">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  );
}
