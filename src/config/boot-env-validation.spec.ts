import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boots the real entry point with an invalid environment on the built-in PostgreSQL path, the one
 * that does Docker I/O before NestFactory.create. The config must be rejected once, before any of
 * that runs, instead of starting the container and then failing inside the module graph.
 */
describe('main.ts validates the environment before any boot side effect', () => {
  const REPO = join(__dirname, '..', '..');
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'openwa-boot-env-'));
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('exits 1 with one fatal line and never reaches DockerService', () => {
    const result = spawnSync(
      join(REPO, 'node_modules', '.bin', 'ts-node-transpile-only'),
      ['--project', join(REPO, 'tsconfig.json'), join(REPO, 'src', 'main.ts')],
      {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LOG_LEVEL: 'bogus',
          DATABASE_TYPE: 'postgres',
          POSTGRES_BUILTIN: 'true',
          DATABASE_HOST: 'db',
          DATABASE_USERNAME: 'u',
          DATABASE_PASSWORD: 'p',
          DOCKER_HOST: 'tcp://127.0.0.1:1',
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Fatal error during bootstrap');
    expect(output).toContain('LOG_LEVEL must be one of');
    expect(output).not.toContain('Unhandled promise rejection');
    expect(output).not.toContain('DockerService');
    expect(output.match(/LOG_LEVEL must be one of/g)).toHaveLength(1);
  }, 90_000);
});

/**
 * The production secret guard only checks what main.ts hands it, and every field of SecretCheckEnv is optional, so a
 * field that is declared but not passed, or read from the wrong variable, leaves its check dead without any error:
 * the guard simply never sees the value. TypeScript cannot tell, so the call is read as source.
 */
describe('main.ts hands the production secret guard every value it checks', () => {
  const read = (file: string): string => readFileSync(join(__dirname, '..', file), 'utf8');
  // The fields whose variable is not the field name in upper snake case.
  const VARIABLES: Record<string, string> = {
    postgresBuiltIn: 'POSTGRES_BUILTIN',
    minioBuiltIn: 'MINIO_BUILTIN',
    s3AccessKey: 'S3_ACCESS_KEY_ID',
    s3SecretKey: 'S3_SECRET_ACCESS_KEY',
  };
  const variableOf = (field: string): string =>
    VARIABLES[field] ?? field.replace(/([a-z\d])([A-Z])/g, '$1_$2').toUpperCase();

  const declared = [
    ...(
      /export interface SecretCheckEnv \{([\s\S]*?)\n\}/.exec(read('config/bootstrap-security.ts'))?.[1] ?? ''
    ).matchAll(/^ {2}(\w+)\?:/gm),
  ].map(match => match[1]);
  const passed = /assertNoDefaultSecretsInProduction\(\{([\s\S]*?)\n {2}\}\);/.exec(read('main.ts'))?.[1] ?? '';

  it('finds the fields the guard declares and the call that fills them', () => {
    expect(declared).toEqual(expect.arrayContaining(['nodeEnv', 'databasePassword', 'apiMasterKey', 'redisPassword']));
    expect(passed).toContain('nodeEnv: process.env.NODE_ENV');
  });

  it('passes every declared field, each read from its own environment variable', () => {
    const unwired = declared.filter(
      field => !new RegExp(`^ {4}${field}: .*process\\.env\\.${variableOf(field)}\\b`, 'm').test(passed),
    );

    expect(unwired).toEqual([]);
  });
});
