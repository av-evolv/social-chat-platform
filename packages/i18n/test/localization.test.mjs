import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDate, formatNumber, locales, matchLocale, negotiateLocale, normalizeLocale, resources, translate } from '../index.js';

function leaves(value, prefix = '') {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'string' ? [[path, child]] : Object.entries(leaves(child, path));
  }));
}
const english = leaves(resources.en.translation);
const french = leaves(resources.fr.translation);
const placeholders = value => [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1]).sort();

test('English and French ship complete, nonempty client and server catalogs with matching interpolation contracts', () => {
  assert.deepEqual(locales, ['en', 'fr']);
  for (const namespace of ['client', 'server', 'common']) {
    assert.ok(Object.keys(english).some(key => key.startsWith(`${namespace}.`)), `${namespace} must contain translated product copy`);
  }
  assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
  for (const [key, value] of Object.entries(english)) {
    assert.ok(value.trim(), `${key}: English is empty`);
    assert.ok(french[key].trim(), `${key}: French is empty`);
    assert.deepEqual(placeholders(french[key]), placeholders(value), `${key}: mismatched interpolation fields`);
    if (placeholders(value).length === 0) {
      assert.equal(translate('en', key), value, `${key}: English lookup failed`);
      assert.equal(translate('fr', key), french[key], `${key}: French lookup failed`);
    }
  }
  assert.ok(Object.values(french).some(value => /[àâçéèêëîïôùûüœ]/i.test(value)), 'French accents survive catalog loading');
});

test('plural messages supply every locale category and interpolate zero, one and several items', () => {
  const pluralRoots = [...new Set(Object.keys(english).filter(key => key.endsWith('_one')).map(key => key.slice(0, -4)))];
  assert.ok(pluralRoots.length > 0, 'Product counts use plural messages');
  for (const locale of locales) {
    const catalog = locale === 'fr' ? french : english;
    for (const root of pluralRoots) {
      for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        assert.ok(catalog[`${root}_${category}`], `${locale}: ${root} lacks ${category}`);
      }
      for (const count of [0, 1, 2, 1_000_000]) {
        const category = new Intl.PluralRules(locale).select(count);
        const template = catalog[`${root}_${category}`];
        const values = Object.fromEntries(placeholders(template).map(name => [name, name === 'count' ? count : `value-${name}`]));
        const result = translate(locale, root, { ...values, count });
        assert.notEqual(result, root, `${locale}: ${root} was unresolved`);
        assert.ok(!result.includes('{{'), `${locale}: ${root} has an unresolved interpolation`);
        assert.equal(result, template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name) => String(values[name])));
      }
    }
  }
});

test('locale choice normalizes regional preferences and falls back predictably', () => {
  assert.equal(matchLocale(' FR-ca '), 'fr');
  assert.equal(matchLocale('en_GB'), 'en');
  assert.equal(matchLocale('de-DE'), undefined);
  for (const value of [undefined, null, '', {}, 'de-DE']) assert.equal(normalizeLocale(value), 'en');
  assert.equal(negotiateLocale('de-DE, fr-CA;q=0.9, en-US;q=0.5'), 'fr');
  assert.equal(negotiateLocale('fr;q=0.1, en;q=0.9'), 'en');
  assert.equal(negotiateLocale('fr;q=0, en;q=0.5'), 'en');
  assert.equal(negotiateLocale('fr;q=invalid, en;q=0.5'), 'en');
  assert.equal(negotiateLocale('fr;q=2, en;q=0.5'), 'en');
  assert.equal(negotiateLocale('fr;q=0.5, en;q=0.5'), 'fr');
  assert.equal(negotiateLocale('*;q=0.9, fr;q=0.8'), 'fr');
  assert.equal(negotiateLocale('de-DE, *;q=0.5'), 'en');
});

test('translation falls back to English and treats interpolated user content as plain text', () => {
  const simple = Object.keys(english).find(key => placeholders(english[key]).length === 0);
  assert.ok(simple);
  assert.equal(translate('es', simple), english[simple]);
  assert.equal(translate('fr-CA', simple), french[simple]);
  const original = resources.fr.translation[simple];
  try {
    delete resources.fr.translation[simple];
    assert.equal(translate('fr', simple), english[simple], 'A missing French message falls back to English');
  } finally { resources.fr.translation[simple] = original; }
  const key = Object.keys(english).find(key => placeholders(english[key]).some(name => name !== 'count') && !/_(one|other|many)$/.test(key));
  assert.ok(key, 'Product copy contains a named interpolation');
  const unsafe = '<b>José & Zoë</b>';
  const values = Object.fromEntries(placeholders(english[key]).map(name => [name, unsafe]));
  const result = translate('en', key, values);
  assert.equal(result, english[key].replace(/{{\s*([^{}]+?)\s*}}/g, () => unsafe));
  assert.equal(translate('fr', 'missing.catalog.key'), 'missing.catalog.key');
});

test('dates and numbers follow the selected language, including French punctuation', () => {
  const date = '2026-09-15T12:00:00.000Z';
  const options = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
  assert.equal(formatDate('en', date, options), 'September 15, 2026');
  assert.equal(formatDate('fr', date, options), '15 septembre 2026');
  assert.equal(formatDate('fr-CA', date, options), formatDate('fr', date, options));
  assert.equal(formatNumber('en', 12345.6), '12,345.6');
  assert.equal(formatNumber('fr', 12345.6), '12\u202f345,6');
  assert.equal(formatNumber('de', 12345.6), '12,345.6');
});
