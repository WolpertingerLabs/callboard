import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalErrorLogging } from './utils/globalErrorLogging';
import './index.css';

// Logs the async/event-handler errors no React boundary can catch. See the file.
installGlobalErrorLogging();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* The backstop. Region boundaries inside SplitLayout and ModalOverlay catch
        most things first; anything above them — SessionProvider, the router, App
        itself — lands here rather than emptying #root. */}
    <ErrorBoundary region="Callboard" variant="root">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
