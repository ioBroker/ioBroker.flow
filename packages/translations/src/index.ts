/**
 * The dictionary, shared by both host bundles.
 *
 * It lives in its own package rather than in one of the bundles because the designer's strings are
 * needed in both, and two copies of nearly two hundred keys would drift apart within one release.
 *
 * `prefix` is what `I18n.extendTranslations` uses to namespace every key, so `insp_node` is stored as
 * `flow_insp_node` and cannot collide with another widget set. Both hosts go through that same
 * function -- vis-2 when it loads the widget set, the device manager in its plugin loader -- so this
 * one module serves both.
 *
 * Only `en` and `de` are filled in. The other files are intentionally empty rather than English
 * copies: `I18n.t` falls back to English for a missing key, and an empty file says "not translated
 * yet" where a copy would claim otherwise.
 */
import en from './en.json';
import de from './de.json';
import ru from './ru.json';
import pt from './pt.json';
import nl from './nl.json';
import fr from './fr.json';
import it from './it.json';
import es from './es.json';
import pl from './pl.json';
import uk from './uk.json';
import zhCn from './zh-cn.json';

/** Namespace of every key of this adapter */
export const I18N_PREFIX = 'flow_';

const translations = {
    en,
    de,
    ru,
    pt,
    nl,
    fr,
    it,
    es,
    pl,
    uk,
    'zh-cn': zhCn,
    prefix: I18N_PREFIX,
};

export default translations;
