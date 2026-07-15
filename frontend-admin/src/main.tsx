import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './styles.css';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN || (import.meta.env.PROD ? 'https://d9966b77bda1549b1d7ef234dd8d243a@o4511479728046080.ingest.us.sentry.io/4511479747969024' : '');

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.VITE_APP_ENV || 'development',
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0),
    release: import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<div style={{ padding: 24, color: '#eef3f7', background: '#07090d', minHeight: '100vh' }}>Admin dashboard error. Please refresh or contact engineering.</div>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
