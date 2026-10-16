export {};

declare global {
  type RoundaboutLanguage = 'auto' | 'en' | 'es' | 'fr' | 'de' | 'pt' | 'it' | 'ja' | 'zh' | 'ko' | 'ru';

  interface RoundaboutRenderOptions {
    sitekey: string;
    theme?: 'light' | 'dark' | 'auto';
    size?: 'normal' | 'compact' | 'flexible';
    appearance?: 'always' | 'execute' | 'interaction-only';
    execution?: 'render' | 'execute';
    language?: RoundaboutLanguage;
    action?: string;
    cdata?: string;
    retry?: 'auto' | 'never';
    /** Milliseconds between automatic retries (default 8000). */
    'retry-interval'?: number;
    'refresh-expired'?: 'auto' | 'never';
    'response-field-name'?: string | false;
    callback?: (token: string) => void;
    'error-callback'?: (code: string) => void;
    'expired-callback'?: () => void;
    'timeout-callback'?: () => void;
    'before-interactive-callback'?: () => void;
    'after-interactive-callback'?: () => void;
    'unsupported-callback'?: () => void;
  }

  interface RoundaboutApi {
    render(container: HTMLElement | string, options: RoundaboutRenderOptions): string;
    execute(widgetId?: string): void;
    reset(widgetId?: string): void;
    remove(widgetId: string): void;
    getResponse(widgetId?: string): string | undefined;
    isExpired(widgetId?: string): boolean;
    ready(cb: () => void): void;
  }

  interface Window {
    roundabout?: RoundaboutApi;
  }
}
