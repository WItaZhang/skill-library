#!/usr/bin/env python3
"""Compose committed modules in a temporary directory; never merge or modify worktrees."""
import argparse
import io
import pathlib
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser()
for name in ('service', 'runtime', 'broadcast'):
    parser.add_argument(f'--{name}-worktree', required=True, type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]

def extract(repo, paths, dest):
    payload = subprocess.check_output(['git', '-C', str(repo), 'archive', '--format=tar', 'HEAD', *paths])
    with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError(f'Unsupported archive member: {member.name}')
        archive.extractall(dest)

with tempfile.TemporaryDirectory(prefix='skill-v2-acceptance-') as temporary:
    dest = pathlib.Path(temporary)
    extract(root, ['src/contracts', 'src/package.json', 'src/acceptance'], dest)
    for name in ('service', 'runtime', 'broadcast'):
        source = getattr(args, f'{name}_worktree').resolve()
        path = pathlib.Path('src/modules') / name
        extract(source, [str(path)], dest)
        dependencies = source / path / 'node_modules'
        if dependencies.exists():
            (dest / path / 'node_modules').symlink_to(dependencies, target_is_directory=True)
        sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        print(f'{name}: {sha}', flush=True)
    subprocess.run(['node', '--experimental-strip-types', '--test', 'src/acceptance/publication.test.ts'], cwd=dest, check=True)
    subprocess.run(['node', '--experimental-strip-types', '--test', 'src/modules/runtime/test/runtime.test.ts'], cwd=dest, check=True)
