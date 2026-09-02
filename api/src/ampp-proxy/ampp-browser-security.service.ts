import { Injectable } from '@nestjs/common';

import type { AmppBrowserResponse } from './ampp-response-rewriter.service';

@Injectable()
export class AmppBrowserSecurityService {
  secureUiResponse(response: AmppBrowserResponse): AmppBrowserResponse {
    return {
      ...response,
      headers: this.secureHeaders(response.headers),
    };
  }

  private secureHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const locationName = Object.keys(headers).find(
      (name) => name.toLowerCase() === 'location',
    );

    if (!locationName) {
      return headers;
    }

    return {
      ...headers,
      [locationName]: this.secureLocation(headers[locationName]),
    };
  }

  private secureLocation(location: string): string {
    return location.replace(
      /([#&](?:access_token|id_token)=)([^&#]*)/gi,
      (match, prefix: string, encodedToken: string) => {
        try {
          const token = decodeURIComponent(encodedToken);
          return `${prefix}${encodeURIComponent(
            this.createBrowserOnlyToken(token),
          )}`;
        } catch {
          return `${prefix}${encodeURIComponent('ampp-proxy')}`;
        }
      },
    );
  }

  private createBrowserOnlyToken(token: string): string {
    const parts = token.split('.');

    if (parts.length < 3) {
      return 'ampp-proxy';
    }

    parts[parts.length - 1] = 'ampp-proxy';
    return parts.join('.');
  }
}
