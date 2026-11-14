// Every catalog, typed against the English one: a missing key is a type error
// (extra keys are caught by i18n.test.ts). Not imported by the widget (catalogs load on demand); used by
// tests and the build step that emits dist/widget/i18n/<lng>.js.

import type { Dict, Locale } from "../i18n";
import { en } from "../i18n";
import ar from "./ar.json";
import az from "./az.json";
import cs from "./cs.json";
import de from "./de.json";
import es from "./es.json";
import fr from "./fr.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import nl from "./nl.json";
import pl from "./pl.json";
import pt from "./pt.json";
import tr from "./tr.json";
import zhCN from "./zh-CN.json";

export const catalogs = { en, es, fr, de, pt, it, nl, pl, cs, ja, "zh-CN": zhCN, ko, tr, az, ar } satisfies Record<Locale, Dict>;
