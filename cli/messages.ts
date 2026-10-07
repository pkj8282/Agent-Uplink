// CLI(agent-uplink-viewer) 문구표(ko/en).
import { defineCatalog, type Lang } from "../shared/i18n.js";

export const CLI_MESSAGES = defineCatalog({
  ko: {
    opened: "브라우저에서 뷰어를 열었습니다.",
    open_failed: (p: { detail: string }) => `뷰어를 열지 못했습니다: ${p.detail}`,
    viewer_off: "뷰어가 꺼져 있습니다.",
    ticket_failed: (p: { detail: string }) => `뷰어 주소를 받지 못했습니다: ${p.detail}`,
    bad_viewer_url: "Hub가 잘못된 뷰어 주소를 보냈습니다.",
  },
  en: {
    opened: "Opened the viewer in your browser.",
    open_failed: (p: { detail: string }) => `Could not open the viewer: ${p.detail}`,
    viewer_off: "The viewer is off.",
    ticket_failed: (p: { detail: string }) => `Could not get the viewer address: ${p.detail}`,
    bad_viewer_url: "The hub sent an invalid viewer address.",
  },
});

export function cliMsg(lang: Lang, key: keyof typeof CLI_MESSAGES.ko, params?: object): string {
  const e = CLI_MESSAGES[lang][key] as string | ((p: object | undefined) => string);
  return typeof e === "function" ? e(params) : e;
}
