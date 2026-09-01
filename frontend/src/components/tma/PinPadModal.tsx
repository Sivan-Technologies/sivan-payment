import React, { useState, useEffect, useCallback } from 'react';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        HapticFeedback?: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
          selectionChanged: () => void;
        };
        BiometricManager?: {
          isInited: boolean;
          isBiometricAvailable: boolean;
          biometricType: 'finger' | 'face' | 'unknown';
          isAccessRequested: boolean;
          isAccessGranted: boolean;
          isBiometricTokenSaved: boolean;
          deviceId: string;
          init: (callback?: () => void) => void;
          requestAccess: (params: { reason?: string }, callback?: (granted: boolean) => void) => void;
          authenticate: (params: { reason?: string }, callback?: (authenticated: boolean, biometricToken?: string) => void) => void;
          updateBiometricToken: (token: string, callback?: (applied: boolean) => void) => void;
          openSettings: () => void;
        };
        themeParams?: Record<string, string>;
      };
    };
  }
}

interface PinPadModalProps {
  userId?: string;
  amount?: string;
  currency?: string;
  recipient?: string;
  txType?: string;
  destinationRef?: string;
  onSuccess?: (stepUpToken: string) => void;
  onCancel?: () => void;
}

export const PinPadModal: React.FC<PinPadModalProps> = ({
  userId: propUserId,
  amount: propAmount,
  currency: propCurrency,
  recipient: propRecipient,
  destinationRef: propDestinationRef,
  onSuccess,
  onCancel,
}) => {
  // Read params from props or URL query string (for direct Mini-App Webview launches)
  const [params, setParams] = useState({
    userId: propUserId || '',
    amount: propAmount || '0.00',
    currency: propCurrency || 'USDC',
    recipient: propRecipient || 'Recipient',
    destinationRef: propDestinationRef || '',
  });

  const [pin, setPin] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shake, setShake] = useState<boolean>(false);
  const [success, setSuccess] = useState<boolean>(false);

  useEffect(() => {
    // Notify Telegram Mini-App readiness
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }

    // Parse URL query params if props are omitted
    if (!propUserId) {
      const urlParams = new URLSearchParams(window.location.search);
      setParams({
        userId: urlParams.get('userId') || '',
        amount: urlParams.get('amount') || '0.00',
        currency: (urlParams.get('currency') || 'USDC').toUpperCase(),
        recipient: urlParams.get('recipient') || urlParams.get('destination') || 'Recipient',
        destinationRef: urlParams.get('destinationRef') || urlParams.get('recipient') || '',
      });
    }
  }, [propUserId, propAmount, propCurrency, propRecipient, propDestinationRef]);

  const triggerHaptic = (type: 'tap' | 'error' | 'success') => {
    const haptic = window.Telegram?.WebApp?.HapticFeedback;
    if (!haptic) return;
    if (type === 'tap') haptic.impactOccurred('light');
    if (type === 'error') haptic.notificationOccurred('error');
    if (type === 'success') haptic.notificationOccurred('success');
  };

  const [biometricAvailable, setBiometricAvailable] = useState<boolean>(false);

  useEffect(() => {
    const bm = window.Telegram?.WebApp?.BiometricManager;
    if (bm) {
      bm.init(() => {
        if (bm.isBiometricAvailable) {
          setBiometricAvailable(true);
        }
      });
    } else if (typeof window !== 'undefined' && window.PublicKeyCredential) {
      setBiometricAvailable(true);
    }
  }, []);

  const triggerTmaBiometric = () => {
    const bm = window.Telegram?.WebApp?.BiometricManager;
    if (!bm) return;

    bm.authenticate({ reason: `Authorize ${params.amount} ${params.currency} payment` }, async (authenticated, biometricToken) => {
      if (authenticated && biometricToken) {
        setLoading(true);
        try {
          const res = await fetch('/api/identity/passkey/tma/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: params.userId,
              biometricToken,
              amount: params.amount,
              currency: params.currency,
              destinationRef: params.destinationRef || params.recipient,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error?.message || 'Biometric verification failed');

          triggerHaptic('success');
          setSuccess(true);
          if (onSuccess) onSuccess(json.data.stepUpToken);
          setTimeout(() => window.Telegram?.WebApp?.close(), 900);
        } catch (err: any) {
          triggerHaptic('error');
          setErrorMessage(err.message || 'Biometric authentication failed');
        } finally {
          setLoading(false);
        }
      }
    });
  };

  const handleBiometricAuth = () => {
    const bm = window.Telegram?.WebApp?.BiometricManager;
    if (bm && bm.isBiometricAvailable) {
      if (!bm.isAccessGranted) {
        bm.requestAccess({ reason: 'Authorize high-value transfers ($50+) with Face ID' }, (granted) => {
          if (granted) triggerTmaBiometric();
        });
      } else {
        triggerTmaBiometric();
      }
    } else {
      triggerHaptic('tap');
      setErrorMessage('Biometrics not configured on this device. Please enter your 6-digit PIN.');
    }
  };

  const handleBackspace = () => {
    if (loading || success || pin.length === 0) return;
    triggerHaptic('tap');
    setPin((prev) => prev.slice(0, -1));
  };

  const submitPin = useCallback(
    async (completedPin: string) => {
      setLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch('/api/identity/pin/verify-step-up', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: params.userId,
            pin: completedPin,
            amount: params.amount,
            currency: params.currency,
            destinationRef: params.destinationRef || params.recipient,
            channel: 'telegram',
          }),
        });

        const json = await response.json();

        if (!response.ok) {
          throw new Error(json.error?.message || 'Invalid PIN entered');
        }

        triggerHaptic('success');
        setSuccess(true);

        if (onSuccess) {
          onSuccess(json.data.stepUpToken);
        }

        // Auto close TMA modal after brief success state
        setTimeout(() => {
          if (window.Telegram?.WebApp) {
            window.Telegram.WebApp.close();
          }
        }, 900);
      } catch (err: any) {
        triggerHaptic('error');
        setShake(true);
        setErrorMessage(err.message || 'Authentication failed');
        setPin('');
        setTimeout(() => setShake(false), 500);
      } finally {
        setLoading(false);
      }
    },
    [params, onSuccess]
  );

  // Auto-submit when 6th digit is reached
  useEffect(() => {
    if (pin.length === 6 && !loading) {
      submitPin(pin);
    }
  }, [pin, loading, submitPin]);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#070B11',
        color: '#EAF0F6',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '24px 16px',
        boxSizing: 'border-box',
      }}
    >
      {/* Top Header & Drag Handle */}
      <div style={{ width: '100%', maxWidth: '360px', textAlign: 'center' }}>
        <div
          style={{
            width: '40px',
            height: '4px',
            backgroundColor: '#1D2A3A',
            borderRadius: '2px',
            margin: '0 auto 16px auto',
          }}
        />

        <div style={{ fontSize: '13px', fontWeight: 600, color: '#4CD8C8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Security Authentication
        </div>

        {/* Transaction Summary Card */}
        <div
          style={{
            marginTop: '12px',
            backgroundColor: '#0E1621',
            border: '1px solid #1D2A3A',
            borderRadius: '16px',
            padding: '16px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div style={{ fontSize: '12px', color: '#8A99AB' }}>Confirm High-Value Transfer</div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: '#FFFFFF', marginTop: '4px' }}>
            {params.amount} <span style={{ color: '#4CD8C8', fontSize: '18px' }}>{params.currency}</span>
          </div>
          <div style={{ fontSize: '13px', color: '#C7D2DE', marginTop: '4px' }}>
            To: <span style={{ fontFamily: 'monospace', color: '#4B8BF4' }}>{params.recipient}</span>
          </div>
        </div>
      </div>

      {/* 6 Masked PIN Dots & Status */}
      <div style={{ textAlign: 'center', margin: '20px 0' }}>
        <div style={{ fontSize: '14px', color: '#8A99AB', marginBottom: '14px' }}>
          Enter your 6-digit Sivan Transaction PIN
        </div>

        <div
          style={{
            display: 'flex',
            gap: '14px',
            justifyContent: 'center',
            transform: shake ? 'translateX(-8px)' : 'none',
            transition: 'transform 0.1s ease',
          }}
        >
          {[0, 1, 2, 3, 4, 5].map((index) => {
            const isFilled = pin.length > index;
            return (
              <div
                key={index}
                style={{
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  backgroundColor: isFilled ? '#4CD8C8' : 'transparent',
                  border: isFilled ? '2px solid #4CD8C8' : '2px solid #2A3B4E',
                  boxShadow: isFilled ? '0 0 12px rgba(76, 216, 200, 0.6)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              />
            );
          })}
        </div>

        {errorMessage && (
          <div style={{ marginTop: '12px', color: '#E26E65', fontSize: '13px', fontWeight: 500 }}>
            {errorMessage}
          </div>
        )}

        {success && (
          <div style={{ marginTop: '12px', color: '#2ECC71', fontSize: '14px', fontWeight: 600 }}>
            ✓ Authenticated! Authorizing transaction...
          </div>
        )}
      </div>

      {/* 3x4 Tactile Numeric Keypad */}
      <div
        style={{
          width: '100%',
          maxWidth: '320px',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px',
        }}
      >
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            onClick={() => handleDigit(digit)}
            disabled={loading || success}
            style={{
              backgroundColor: '#0E1621',
              color: '#FFFFFF',
              border: '1px solid #1A2433',
              borderRadius: '16px',
              fontSize: '22px',
              fontWeight: 600,
              padding: '16px 0',
              cursor: 'pointer',
              outline: 'none',
              transition: 'background-color 0.1s, transform 0.05s',
              WebkitTapHighlightColor: 'transparent',
            }}
            onMouseDown={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
            onMouseUp={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
            onTouchStart={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
            onTouchEnd={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
          >
            {digit}
          </button>
        ))}

        {/* Biometrics / Face ID */}
        <button
          onClick={handleBiometricAuth}
          disabled={loading || success}
          style={{
            backgroundColor: '#0E1621',
            color: '#4CD8C8',
            border: '1px solid #1A2433',
            borderRadius: '16px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            outline: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
            WebkitTapHighlightColor: 'transparent',
          }}
          onMouseDown={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
          onMouseUp={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
          onTouchStart={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
          onTouchEnd={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
        >
          ⚡ Face ID
        </button>

        {/* Zero */}
        <button
          onClick={() => handleDigit('0')}
          disabled={loading || success}
          style={{
            backgroundColor: '#0E1621',
            color: '#FFFFFF',
            border: '1px solid #1A2433',
            borderRadius: '16px',
            fontSize: '22px',
            fontWeight: 600,
            padding: '16px 0',
            cursor: 'pointer',
            outline: 'none',
            transition: 'background-color 0.1s',
            WebkitTapHighlightColor: 'transparent',
          }}
          onMouseDown={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
          onMouseUp={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
          onTouchStart={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
          onTouchEnd={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
        >
          0
        </button>

        {/* Backspace */}
        <button
          onClick={handleBackspace}
          disabled={loading || success}
          style={{
            backgroundColor: '#0E1621',
            color: '#8A99AB',
            border: '1px solid #1A2433',
            borderRadius: '16px',
            fontSize: '18px',
            fontWeight: 600,
            padding: '16px 0',
            cursor: 'pointer',
            outline: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            WebkitTapHighlightColor: 'transparent',
          }}
          onMouseDown={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
          onMouseUp={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
          onTouchStart={(e) => (e.currentTarget.style.backgroundColor = '#1D2A3A')}
          onTouchEnd={(e) => (e.currentTarget.style.backgroundColor = '#0E1621')}
        >
          ⌫
        </button>
      </div>
    </div>
  );
};

export default PinPadModal;
