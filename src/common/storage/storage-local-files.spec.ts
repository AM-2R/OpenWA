import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { iterateLocalFiles, type LocalWalkOptions } from './storage-local-files';

describe('iterateLocalFiles', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-walk-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'x');
  };

  const walk = async (prefix = '', options?: LocalWalkOptions): Promise<string[]> => {
    const files: string[] = [];
    for await (const file of iterateLocalFiles(root, prefix, options)) files.push(file);
    return files.sort();
  };

  /** A mode-000 directory is still readable by root, so the failure is injected for the one path. */
  const failReaddirAt = (suffix: string, code = 'EACCES'): Error => {
    const error = Object.assign(new Error(`${code}: cannot read ${suffix}`), { code });
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        String(target).endsWith(suffix) ? Promise.reject(error) : readdir(target, ...rest)) as never);
    return error;
  };

  const deepKey = [...Array<string>(20).fill('d'), 'deep.bin'].join('/');

  it('lists every file with "/" separated keys', async () => {
    write('a.bin');
    write('x/y/b.bin');

    expect(await walk()).toEqual(['a.bin', 'x/y/b.bin']);
    expect(await walk('x/')).toEqual(['x/y/b.bin']);
  });

  describe('by default', () => {
    it('fails on a directory it cannot read, with the error it got', async () => {
      write('ok.bin');
      write('locked/hidden.bin');
      const error = failReaddirAt(path.join(root, 'locked'));

      await expect(walk()).rejects.toBe(error);
    });

    it('fails on a directory below the maximum depth', async () => {
      write(deepKey);

      await expect(walk()).rejects.toThrow(/maximum traversal depth/);
    });

    // A link is neither followed (it can loop, or leave the store) nor listed, so what it points at would be
    // missing from an export or a count without a word. Refusing is the only answer that cannot lose it.
    it.each([
      ['directory', 'linked'],
      ['file', 'alias.bin'],
    ])('fails on a symbolic link to a %s, naming it', async (kind, name) => {
      write('real/inside.bin');
      write('real.bin');
      fs.symlinkSync(path.join(root, kind === 'directory' ? 'real' : 'real.bin'), path.join(root, name));

      await expect(walk()).rejects.toThrow(new RegExp(`symbolic link.*${name.replace('.', '\\.')}`));
    });

    it('walks a prefix that is itself a symbolic link, since the walk starts from a path', async () => {
      write('elsewhere/s1/archived.bin');
      fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'chat-media'));

      expect(await walk('chat-media/')).toEqual(['chat-media/s1/archived.bin']);
    });

    it('treats a directory removed during the walk as empty', async () => {
      write('ok.bin');
      write('gone/file.bin');
      failReaddirAt(path.join(root, 'gone'), 'ENOENT');

      expect(await walk()).toEqual(['ok.bin']);
    });
  });

  describe('when asked to skip what it cannot read', () => {
    const lenient = (): { options: LocalWalkOptions; warn: jest.Mock } => {
      const warn = jest.fn();
      return { options: { skipUnreadable: true, logger: { warn } }, warn };
    };

    it('skips an unreadable directory, names it, and still lists the rest', async () => {
      write('ok.bin');
      write('locked/hidden.bin');
      write('other/fine.bin');
      failReaddirAt(path.join(root, 'locked'));
      const { options, warn } = lenient();

      expect(await walk('', options)).toEqual(['ok.bin', 'other/fine.bin']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"locked"'));
    });

    it('skips a directory below the maximum depth and still lists the rest', async () => {
      write('ok.bin');
      write(deepKey);
      const { options, warn } = lenient();

      expect(await walk('', options)).toEqual(['ok.bin']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('maximum traversal depth'));
    });

    it('skips a symbolic link, names it, and still lists the rest', async () => {
      write('ok.bin');
      write('real/inside.bin');
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
      const { options, warn } = lenient();

      expect(await walk('', options)).toEqual(['ok.bin', 'real/inside.bin']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"linked".*symbolic link/));
    });

    it('skips without a logger too', async () => {
      write('ok.bin');
      write('locked/hidden.bin');
      failReaddirAt(path.join(root, 'locked'));

      expect(await walk('', { skipUnreadable: true })).toEqual(['ok.bin']);
    });
  });
});
