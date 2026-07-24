function redactSensitiveValues(message: string): string {
  return message
    .replace(
      /([?&](?:access_token|id_token|token|code)=)[^&\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
      '$1[REDACTED]',
    );
}

function formatFrontendSessionId(frontendSessionId?: string): string {
  if (!frontendSessionId) {
    return '';
  }

  const shortenedSessionId =
    frontendSessionId.length > 12
      ? `${frontendSessionId.slice(0, 8)}...${frontendSessionId.slice(-4)}`
      : frontendSessionId;

  return ` frontendSession=${shortenedSessionId}`;
}

export function amppProxySessionDebugLog(
  message: string,
  frontendSessionId?: string,
): void {
  if (process.env.AMPP_PROXY_SESSION_DEBUG === 'true') {
    console.log(
      `[AMPP proxy session] ${redactSensitiveValues(message)}${formatFrontendSessionId(frontendSessionId)}`,
    );
  }
}

export function amppProxySessionDebugWarn(
  message: string,
  frontendSessionId?: string,
): void {
  if (process.env.AMPP_PROXY_SESSION_DEBUG === 'true') {
    console.warn(
      `[AMPP proxy session] ${redactSensitiveValues(message)}${formatFrontendSessionId(frontendSessionId)}`,
    );
  }
}
