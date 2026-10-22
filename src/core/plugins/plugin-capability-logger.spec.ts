import { HookManager } from '../hooks';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginHostServices } from './plugin-host-services';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { createLogger } from '../../common/services/logger.service';

describe('the logger a plugin gets', () => {
  const manifest: PluginManifest = {
    id: 'p1',
    name: 'P1',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
  };

  const setup = () => {
    const host = { error: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const context = new PluginCapabilityContext(
      host as unknown as ReturnType<typeof createLogger>,
      {} as PluginHostServices,
      new HookManager(),
      { createPluginStorage: () => ({}) } as unknown as PluginStorageService,
    );
    const plugin = {
      manifest,
      status: PluginStatus.ENABLED,
      config: {},
      sessionConfig: {},
    } as unknown as PluginInstance;
    return { host, logger: context.createPluginContext(plugin).logger };
  };

  it('passes no trace when an error line has no error, so the line does not carry the text "undefined"', () => {
    const { host, logger } = setup();

    logger.error('upload failed');
    logger.error('upload failed', undefined, { sessionId: 's1' });

    expect(host.error).toHaveBeenNthCalledWith(1, '[p1] upload failed', undefined, { pluginId: 'p1' });
    expect(host.error).toHaveBeenNthCalledWith(2, '[p1] upload failed', undefined, { sessionId: 's1', pluginId: 'p1' });
  });

  it('passes the message of an Error, and the text of anything else, as the trace', () => {
    const { host, logger } = setup();

    logger.error('upload failed', new Error('boom'));
    logger.error('upload failed', 'plain text');
    logger.error('upload failed', 404);
    logger.error('upload failed', null);

    expect(host.error.mock.calls.map((call: unknown[]) => call[1])).toEqual(['boom', 'plain text', '404', 'null']);
  });
});
