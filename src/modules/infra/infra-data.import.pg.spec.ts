/* istanbul ignore file: PG-gated, only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { InfraDataController } from './infra-data.controller';
import { InfraDataService } from './infra-data.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { postgresUtcExtra } from '../../database/postgres-utc';

// StorageService (imported transitively by the infra controllers) pulls in `archiver`, which is
// ESM-only and cannot be parsed by ts-jest; the import never touches it.
jest.mock('archiver', () => ({ default: jest.fn() }));

/**
 * The replace-all import trims send_idempotency_keys with a statement that compares the claim's
 * varchar sessionId with sessions.id, a uuid on PostgreSQL. The comparison only holds because the
 * statement casts, and the cast is invisible on SQLite, where both are text: without it every import
 * on PostgreSQL answers imported:false with a warning about idempotency claims.
 */
const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;

describePostgres('InfraDataController.importData (postgres)', () => {
  const schema = `infra_import_${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: DataSource;
  let ds: DataSource;
  let controller: InfraDataController;

  beforeAll(async () => {
    const options = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
    };
    admin = await new DataSource(options).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource({
      ...options,
      schema,
      extra: { ...postgresUtcExtra(), options: `-c search_path=${schema},public` },
      // The full data-connection entity set: exportData validates its table registry against it.
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        ChatState,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        WebhookOutboxEvent,
        IntegrationDeliveryFailure,
        StatusUpdate,
        AutomationRule,
        SendIdempotencyKey,
      ],
      synchronize: true,
    }).initialize();
    const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) };
    controller = new InfraDataController(new InfraDataService(cfg as never, ds, undefined, undefined, undefined));
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('drops the claims of a session the restore removes and keeps those of one it restores', async () => {
    const sessions = ds.getRepository(Session);
    const claims = ds.getRepository(SendIdempotencyKey);
    const [kept, removed] = [randomUUID(), randomUUID()];
    for (const id of [kept, removed]) {
      await sessions.save(
        sessions.create({
          id,
          name: `session-${id.slice(0, 8)}`,
          status: SessionStatus.READY,
          phone: null,
          pushName: null,
          config: {},
          proxyUrl: null,
          proxyType: null,
          connectedAt: null,
          lastActiveAt: null,
        }),
      );
      await claims.save(
        claims.create({
          sessionId: id,
          idempotencyKey: 'order-42',
          route: 'send-text',
          requestHash: 'h',
          state: 'completed',
          responseBody: { messageId: `sent-by-${id}` },
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );
    }
    const dump = await controller.exportData();
    const onlyKept = {
      tables: {
        ...dump.tables,
        sessions: (dump.tables.sessions as unknown as Array<{ id: string }>).filter(row => row.id === kept),
      },
    };

    const result = await controller.importData(onlyKept as never);

    expect(result).toMatchObject({ imported: true });
    expect(result.warnings).toEqual([]);
    expect((await claims.find()).map(claim => claim.sessionId)).toEqual([kept]);
  });

  // The runtime pool cancels a statement that outlives statement_timeout (30 s by default), and the
  // clears of a replace-all import scale with the live tables, not with the archive. A slow trigger on
  // messages stands in for a table that has grown large: with the pool's timeout lowered below it, the
  // import only completes when it lifts the timeout for its own transaction.
  it('completes a restore whose clears outlast the runtime statement timeout', async () => {
    const dump = await controller.exportData();
    const strict = await new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
      schema,
      extra: { ...postgresUtcExtra(), options: `-c search_path=${schema},public`, statement_timeout: 250 },
      entities: ds.options.entities,
      synchronize: false,
    }).initialize();
    const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) };
    const strictController = new InfraDataController(
      new InfraDataService(cfg as never, strict, undefined, undefined, undefined),
    );
    await admin.query(
      `CREATE FUNCTION "${schema}".slow_messages_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER slow_messages_delete BEFORE DELETE ON "${schema}".messages FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".slow_messages_delete()`,
    );
    try {
      // Guard the guard: the lowered timeout does cancel the slow clear outside the import's transaction.
      await expect(strict.query('DELETE FROM messages')).rejects.toThrow(/statement timeout/);

      await expect(strictController.importData(dump as never)).resolves.toMatchObject({ imported: true });
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS slow_messages_delete ON "${schema}".messages`);
      await admin.query(`DROP FUNCTION IF EXISTS "${schema}".slow_messages_delete()`);
      await strict.destroy();
    }
  });
});
