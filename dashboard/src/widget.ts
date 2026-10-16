let loader: Promise<RoundaboutApi> | null = null;

/** Loads /widget/api.js once and resolves with window.roundabout. */
export function loadWidget(): Promise<RoundaboutApi> {
  if (window.roundabout) return Promise.resolve(window.roundabout);
  if (loader) return loader;
  loader = new Promise<RoundaboutApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/widget/api.js?render=explicit';
    script.async = true;
    script.onerror = () => {
      loader = null;
      script.remove();
      reject(new Error('Failed to load /widget/api.js'));
    };
    script.onload = () => {
      const started = Date.now();
      const poll = () => {
        if (window.roundabout) resolve(window.roundabout);
        else if (Date.now() - started > 5000) {
          loader = null;
          reject(new Error('Widget script loaded but window.roundabout never appeared'));
        } else setTimeout(poll, 25);
      };
      poll();
    };
    document.head.appendChild(script);
  });
  return loader;
}
