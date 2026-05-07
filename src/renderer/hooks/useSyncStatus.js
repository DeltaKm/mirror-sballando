import { useEffect, useState } from 'react';

export function useSyncStatus() {
  const [state, setState] = useState({ online: navigator.onLine, pending: 0 });

  useEffect(() => {
    const refresh = async () => {
      if (!window.mirrorApi?.getSyncOverview) {
        return;
      }
      try {
        const overview = await window.mirrorApi.getSyncOverview();
        setState({ online: overview.online, pending: overview.pending });
      } catch {
        setState((prev) => ({ ...prev, online: navigator.onLine }));
      }
    };

    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);

    return () => {
      clearInterval(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  return state;
}
