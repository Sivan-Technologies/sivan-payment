import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './styles.css';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.VITE_APP_ENV || 'development',
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0),
    release: import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<div style={{ padding: 24, color: '#eef3f7', background: '#07090d', minHeight: '100vh' }}>Something went wrong. Please refresh or try again.</div>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
