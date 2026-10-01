# Changelog

## Unreleased

## 0.1.3 - 2026-10-01

- Fix `omp plugin install omp-rig` failing on 0.1.2 with "Cannot find package '@oh-my-pi/pi-catalog'"; the plugin now only uses packages omp provides.

## 0.1.2 - 2026-10-01

- `npx omp-rig install` no longer downloads omp itself; it uses the omp already on your machine and fails with a clear message when omp is missing.

## 0.1.1 - 2026-10-01

- Install from any machine with `npx omp-rig install`, which runs `omp plugin install omp-rig@latest` for you; `npx omp-rig uninstall` removes it.

## 0.1.0 - 2026-10-01

- Switch every configured model role and visible model pool together from the `/rig` list.
- Apply a rig for the current session, project, or profile-wide default without rewriting saved settings.
- Create, edit, copy, rename, import, and export rigs from the interactive menu.
- Check model availability before applying a rig and explain every configuration problem together.
- Start a session with a selected rig through the `--rig` option.
