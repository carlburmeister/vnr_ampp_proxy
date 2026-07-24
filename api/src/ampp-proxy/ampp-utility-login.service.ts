import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieJar } from 'tough-cookie';

import {
  AmppCookieHttpService,
  type AmppCookieHttpResponse,
} from './ampp-cookie-http.service';
import {
  amppProxySessionDebugLog,
  amppProxySessionDebugWarn,
} from './ampp-proxy-session-debug';

type HtmlAttributes = Record<string, string>;

type LoginForm = {
  action: string;
  usernameField: string;
  passwordField: string;
  fields: URLSearchParams;
};

@Injectable()
export class AmppUtilityLoginService {
  constructor(
    private readonly config: ConfigService,
    private readonly http: AmppCookieHttpService,
  ) {}

  async login(returnPath: string): Promise<CookieJar> {
    const username = this.config.getOrThrow<string>('AMPP_PROXY_USER');
    const cookieJar = new CookieJar();

    amppProxySessionDebugLog(
      `Starting AMPP utility login for user=${username} returnPath=${returnPath}`,
    );

    const loginUrl = new URL(
      '/identity/Account/Login',
      this.config.getOrThrow<string>('PLATFORM_URL'),
    );
    loginUrl.searchParams.set('ReturnUrl', returnPath);

    amppProxySessionDebugLog(
      `Requesting explicit AMPP login page url=${loginUrl.toString()}`,
    );

    const loginPage = await this.http.request(cookieJar, loginUrl.toString(), {
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      followRedirects: true,
    });
    const form = this.readLoginForm(loginPage);

    amppProxySessionDebugLog(
      `Submitting AMPP login form for user=${username} action=${form.action}`,
    );

    form.fields.set(form.usernameField, username);
    form.fields.set(
      form.passwordField,
      this.config.getOrThrow<string>('AMPP_PROXY_PASSWORD'),
    );

    const loginResponse = await this.http.request(cookieJar, form.action, {
      method: 'POST',
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(loginPage.url).origin,
        Referer: loginPage.url,
      },
      data: form.fields.toString(),
      followRedirects: true,
    });

    if (
      loginResponse.status >= 400 ||
      this.findCredentialForm(loginResponse.body.toString('utf8'))
    ) {
      amppProxySessionDebugWarn(
        `AMPP utility login failed for user=${username} status=${loginResponse.status} finalUrl=${loginResponse.url}`,
      );
      throw new BadGatewayException('AMPP utility user login failed');
    }

    amppProxySessionDebugLog(
      `AMPP utility login succeeded for user=${username} cookies=${cookieJar.toJSON().cookies?.length ?? 0}`,
    );

    return cookieJar;
  }

  isLoginResponse(response: AmppCookieHttpResponse): boolean {
    if (response.status === 401 || response.status === 403) {
      return true;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = String(response.headers.location ?? '');
      return /login|sign[-_]?in|authenticate/i.test(location);
    }

    const contentType = String(response.headers['content-type'] ?? '');

    return (
      /text\/html|application\/xhtml\+xml/i.test(contentType) &&
      Boolean(this.findCredentialForm(response.body.toString('utf8')))
    );
  }

  private readLoginForm(response: AmppCookieHttpResponse): LoginForm {
    const credentialForm = this.findCredentialForm(
      response.body.toString('utf8'),
    );

    if (!credentialForm) {
      amppProxySessionDebugWarn(
        `AMPP login page did not contain a credential form url=${response.url}`,
      );
      throw new BadGatewayException(
        'AMPP login page did not contain a credential form',
      );
    }

    const inputs = [...credentialForm.html.matchAll(/<input\b[^>]*>/gi)].map(
      ([tag]) => this.readAttributes(tag),
    );
    const passwordInput = inputs.find(
      (input) => input.type?.toLowerCase() === 'password' && input.name,
    );
    const usernameInput =
      inputs.find((input) => {
        const type = (input.type ?? 'text').toLowerCase();
        return (
          input.name &&
          ['text', 'email'].includes(type) &&
          (/user|email|login/i.test(input.name) ||
            input.autocomplete?.toLowerCase() === 'username')
        );
      }) ??
      inputs.find((input) => {
        const type = (input.type ?? 'text').toLowerCase();
        return input.name && ['text', 'email'].includes(type);
      });

    if (!usernameInput?.name || !passwordInput?.name) {
      amppProxySessionDebugWarn(
        `AMPP login form fields could not be identified url=${response.url}`,
      );
      throw new BadGatewayException(
        'AMPP login form fields could not be identified',
      );
    }

    const fields = new URLSearchParams();

    for (const input of inputs) {
      const type = (input.type ?? 'text').toLowerCase();

      if (
        !input.name ||
        input.name === usernameInput.name ||
        input.name === passwordInput.name
      ) {
        continue;
      }

      if (
        type === 'hidden' ||
        ((type === 'checkbox' || type === 'radio') &&
          Object.hasOwn(input, 'checked'))
      ) {
        fields.append(input.name, input.value ?? '');
      }
    }

    const buttons = [
      ...credentialForm.html.matchAll(/<button\b[^>]*>/gi),
    ].map(([tag]) => this.readAttributes(tag));
    const submitControls = [
      ...inputs.filter(
        (input) => input.type?.toLowerCase() === 'submit',
      ),
      ...buttons.filter(
        (button) => (button.type ?? 'submit').toLowerCase() === 'submit',
      ),
    ];
    const submitControl =
      submitControls.find(
        (control) =>
          control.name &&
          /login|sign[-_ ]?in|submit/i.test(
            `${control.name} ${control.value ?? ''}`,
          ),
      ) ?? submitControls.find((control) => control.name);

    if (submitControl?.name) {
      fields.set(submitControl.name, submitControl.value ?? '');
    }

    return {
      action: credentialForm.attributes.action || response.url,
      usernameField: usernameInput.name,
      passwordField: passwordInput.name,
      fields,
    };
  }

  private findCredentialForm(html: string): {
    html: string;
    attributes: HtmlAttributes;
  } | null {
    for (const [formHtml] of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
      if (!/<input\b[^>]*type\s*=\s*["']?password\b/i.test(formHtml)) {
        continue;
      }

      const openingTag = formHtml.match(/^<form\b[^>]*>/i)?.[0] ?? '<form>';
      return {
        html: formHtml,
        attributes: this.readAttributes(openingTag),
      };
    }

    return null;
  }

  private readAttributes(tag: string): HtmlAttributes {
    const attributes: HtmlAttributes = {};
    const attributePattern =
      /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

    for (const match of tag.matchAll(attributePattern)) {
      const name = match[1].toLowerCase();

      if (name === 'form' || name === 'input') {
        continue;
      }

      attributes[name] = this.decodeHtml(
        match[2] ?? match[3] ?? match[4] ?? '',
      );
    }

    return attributes;
  }

  private decodeHtml(value: string): string {
    return value
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_, decimal: string) =>
        String.fromCodePoint(Number.parseInt(decimal, 10)),
      );
  }
}
