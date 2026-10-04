# Contributing to Agent-Uplink

Thanks for your interest! Bug reports, ideas, docs fixes, and code are all welcome.

- **Questions and ideas** → [Discussions](https://github.com/pkj8282/Agent-Uplink/discussions)
- **Bugs and concrete feature requests** → [Issues](https://github.com/pkj8282/Agent-Uplink/issues/new/choose)
- **Security problems** → please report privately, see [SECURITY.md](SECURITY.md). Do not open a public issue.

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: Windows, Node.js 22+, Git.

```bash
git clone https://github.com/pkj8282/Agent-Uplink.git
cd Agent-Uplink
npm ci
npm test          # hub, MCP server, and admin app unit tests
npm run build     # compile hub and MCP server to dist/

cd admin
npm ci
npm run typecheck
npm start         # run the admin app from source
```

Most tests start a real hub on a random port with a temporary data folder, so they never touch your real `%ProgramData%\AgentUplink` data. When running a single test file, add `--test-force-exit`:

```bash
npx tsx --test --test-force-exit hub/server.test.ts
```

See [Architecture](docs/architecture.md) for how the hub, MCP server, viewer, and admin app fit together.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. **Add a test that fails without your change** and passes with it. Bug fixes should come with a test that reproduces the bug.
4. Make sure `npm test` passes, and `cd admin && npm run typecheck` if you touched the admin app.
5. Update the docs in `docs/` (and the README if a user-facing feature changes).
6. Open a pull request describing what changed and why.

Please follow the style of the surrounding code: TypeScript ESM, no new runtime dependencies without discussion, and user data inserted into UIs with `textContent` (never `innerHTML`).

### Language

Tool responses and the bundled UIs are currently in Korean; an English UI is planned. New user-facing errors in the admin app should come from the hub as an error `code` that the app maps to text (see `admin/src/renderer/view.ts`), so they are easy to translate later. Issues and pull requests may be written in English or Korean.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

---

## 한국어 요약

- 질문·아이디어는 [Discussions](https://github.com/pkj8282/Agent-Uplink/discussions), 버그·구체적인 기능 제안은 [Issues](https://github.com/pkj8282/Agent-Uplink/issues/new/choose), 보안 문제는 [SECURITY.md](SECURITY.md)대로 비공개 제보해 주세요.
- 개발 환경: Windows, Node.js 22+. `npm ci` → `npm test` → `npm run build`. 관리 앱은 `admin/`에서 `npm ci` → `npm run typecheck` → `npm start`.
- 변경할 때는 `main`에서 브랜치를 만들고, **변경 없이는 실패하는 테스트**를 함께 넣어 주세요. `npm test`가 통과해야 합니다.
- 이슈·PR은 한국어나 영어 모두 괜찮습니다.
