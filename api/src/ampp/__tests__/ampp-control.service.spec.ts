import { ConfigService } from '@nestjs/config';

import { AmppControlService } from '../services/ampp-control.service';

describe('AmppControlService', () => {
  let service: AmppControlService;

  beforeEach(() => {
    service = new AmppControlService({} as ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
