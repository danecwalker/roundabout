export type MsgKey =
  | "verifying" | "success" | "verify_human" | "failed" | "expired" | "timeout"
  | "refresh" | "retry" | "retrying" | "invalid_sitekey" | "domain_not_allowed"
  | "rate_limited" | "network" | "no_parent" | "generic";

type Table = Record<MsgKey, string>;

const en: Table = {
  verifying: "Verifying…", success: "Success!", verify_human: "Verify you are human",
  failed: "Verification failed", expired: "Expired", timeout: "Timed out", refresh: "Refresh",
  retry: "Retry", retrying: "Retrying…", invalid_sitekey: "Invalid sitekey",
  domain_not_allowed: "Domain not allowed", rate_limited: "Too many attempts",
  network: "Network error", no_parent: "Must be embedded", generic: "Something went wrong",
};

const TABLES: Record<string, Table> = {
  en,
  es: {
    verifying: "Verificando…", success: "¡Listo!", verify_human: "Verifica que eres humano",
    failed: "Verificación fallida", expired: "Caducado", timeout: "Tiempo agotado", refresh: "Actualizar",
    retry: "Reintentar", retrying: "Reintentando…", invalid_sitekey: "Clave de sitio no válida",
    domain_not_allowed: "Dominio no permitido", rate_limited: "Demasiados intentos",
    network: "Error de red", no_parent: "Debe estar incrustado", generic: "Algo salió mal",
  },
  fr: {
    verifying: "Vérification…", success: "Réussi !", verify_human: "Confirmez que vous êtes humain",
    failed: "Échec de la vérification", expired: "Expiré", timeout: "Délai dépassé", refresh: "Actualiser",
    retry: "Réessayer", retrying: "Nouvel essai…", invalid_sitekey: "Clé de site invalide",
    domain_not_allowed: "Domaine non autorisé", rate_limited: "Trop de tentatives",
    network: "Erreur réseau", no_parent: "Doit être intégré", generic: "Une erreur est survenue",
  },
  de: {
    verifying: "Wird überprüft…", success: "Erfolgreich!", verify_human: "Bestätigen Sie, dass Sie ein Mensch sind",
    failed: "Überprüfung fehlgeschlagen", expired: "Abgelaufen", timeout: "Zeitüberschreitung", refresh: "Aktualisieren",
    retry: "Erneut versuchen", retrying: "Neuer Versuch…", invalid_sitekey: "Ungültiger Site-Key",
    domain_not_allowed: "Domain nicht erlaubt", rate_limited: "Zu viele Versuche",
    network: "Netzwerkfehler", no_parent: "Muss eingebettet sein", generic: "Etwas ist schiefgelaufen",
  },
  pt: {
    verifying: "Verificando…", success: "Sucesso!", verify_human: "Confirme que você é humano",
    failed: "Falha na verificação", expired: "Expirado", timeout: "Tempo esgotado", refresh: "Atualizar",
    retry: "Tentar novamente", retrying: "Tentando novamente…", invalid_sitekey: "Chave do site inválida",
    domain_not_allowed: "Domínio não permitido", rate_limited: "Muitas tentativas",
    network: "Erro de rede", no_parent: "Deve estar incorporado", generic: "Algo deu errado",
  },
  it: {
    verifying: "Verifica in corso…", success: "Fatto!", verify_human: "Verifica di essere umano",
    failed: "Verifica non riuscita", expired: "Scaduto", timeout: "Tempo scaduto", refresh: "Aggiorna",
    retry: "Riprova", retrying: "Nuovo tentativo…", invalid_sitekey: "Chiave del sito non valida",
    domain_not_allowed: "Dominio non consentito", rate_limited: "Troppi tentativi",
    network: "Errore di rete", no_parent: "Deve essere incorporato", generic: "Qualcosa è andato storto",
  },
  ja: {
    verifying: "確認中…", success: "成功しました", verify_human: "人間であることを確認してください",
    failed: "確認に失敗しました", expired: "期限切れ", timeout: "タイムアウト", refresh: "更新",
    retry: "再試行", retrying: "再試行中…", invalid_sitekey: "無効なサイトキー",
    domain_not_allowed: "許可されていないドメイン", rate_limited: "試行回数が多すぎます",
    network: "ネットワークエラー", no_parent: "埋め込みが必要です", generic: "問題が発生しました",
  },
  zh: {
    verifying: "正在验证…", success: "验证成功", verify_human: "请确认您是真人",
    failed: "验证失败", expired: "已过期", timeout: "已超时", refresh: "刷新",
    retry: "重试", retrying: "正在重试…", invalid_sitekey: "无效的站点密钥",
    domain_not_allowed: "域名不被允许", rate_limited: "尝试次数过多",
    network: "网络错误", no_parent: "必须嵌入使用", generic: "出了点问题",
  },
  ko: {
    verifying: "확인 중…", success: "성공!", verify_human: "사람인지 확인하세요",
    failed: "확인 실패", expired: "만료됨", timeout: "시간 초과", refresh: "새로고침",
    retry: "다시 시도", retrying: "다시 시도 중…", invalid_sitekey: "잘못된 사이트 키",
    domain_not_allowed: "허용되지 않은 도메인", rate_limited: "시도 횟수 초과",
    network: "네트워크 오류", no_parent: "임베드해야 합니다", generic: "문제가 발생했습니다",
  },
  ru: {
    verifying: "Проверка…", success: "Готово!", verify_human: "Подтвердите, что вы человек",
    failed: "Проверка не пройдена", expired: "Истекло", timeout: "Время истекло", refresh: "Обновить",
    retry: "Повторить", retrying: "Повтор…", invalid_sitekey: "Неверный ключ сайта",
    domain_not_allowed: "Домен не разрешён", rate_limited: "Слишком много попыток",
    network: "Ошибка сети", no_parent: "Требуется встраивание", generic: "Что-то пошло не так",
  },
};

export const LANGUAGES = Object.keys(TABLES);

/** Resolve `auto` (or an unsupported code) against the browser's languages. */
export function resolveLanguage(requested: string | null): string {
  const pick = (code: string) => {
    const base = code.toLowerCase().split("-")[0];
    return TABLES[base] ? base : null;
  };
  if (requested && requested !== "auto") {
    const r = pick(requested);
    if (r) return r;
  }
  for (const l of navigator.languages ?? [navigator.language]) {
    const r = l && pick(l);
    if (r) return r;
  }
  return "en";
}

export function translator(lang: string): (k: MsgKey) => string {
  const t = TABLES[lang] ?? en;
  return (k) => t[k] ?? en[k];
}
