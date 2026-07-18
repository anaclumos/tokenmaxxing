import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { uiTranslations } from 'fumadocs-ui/i18n';
import { i18n, localePath } from './i18n';
import { appName, gitConfig } from './shared';
import zh from './translations/zh';
import hi from './translations/hi';
import es from './translations/es';
import ar from './translations/ar';
import fr from './translations/fr';
import bn from './translations/bn';
import pt from './translations/pt';
import ru from './translations/ru';
import id from './translations/id';
import ur from './translations/ur';
import de from './translations/de';
import ja from './translations/ja';
import pcm from './translations/pcm';
import arz from './translations/arz';
import mr from './translations/mr';
import vi from './translations/vi';
import te from './translations/te';
import ha from './translations/ha';
import tr from './translations/tr';
import pnb from './translations/pnb';
import sw from './translations/sw';
import tl from './translations/tl';
import ta from './translations/ta';
import yue from './translations/yue';
import wuu from './translations/wuu';
import fa from './translations/fa';
import ko from './translations/ko';
import am from './translations/am';
import th from './translations/th';

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    en: { displayName: 'English' },
    zh,
    hi,
    es,
    ar,
    fr,
    bn,
    pt,
    ru,
    id,
    ur,
    de,
    ja,
    pcm,
    arz,
    mr,
    vi,
    te,
    ha,
    tr,
    pnb,
    sw,
    tl,
    ta,
    yue,
    wuu,
    fa,
    ko,
    am,
    th,
  });

export function baseOptions({ locale }: { locale: string }): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: localePath({ locale, path: '' }),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
