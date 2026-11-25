# Blueprints Reference

Blueprints are declarative JSON files (`--blueprint=./blueprint.json` or an HTTP(S) URL) executed after the CMS boots in PHP-WASM. All file and directory paths are resolved **relative to `/var/www/html`**.

```json
{
  "preferredVersions": {
    "php": "8.4",
    "joomla": "6.2"
  },
  "landingPage": "/administrator/",
  "steps": [
    { "step": "mkdir", "path": "custom" },
    { "step": "writeFile", "path": "custom/hello.txt", "data": "Hello" },
    { "step": "runPHP", "code": "file_put_contents('custom/php-version.txt', PHP_VERSION);" }
  ]
}
```

## Core Steps (all CMSs)

| Step | Key fields | Description |
| --- | --- | --- |
| `runPHP` | `code` | Execute inline PHP code with working directory `/var/www/html`. |
| `writeFile` | `path`, `data` | Write a file relative to `/var/www/html` (creates parent directories automatically). |
| `mkdir` | `path` | Create a directory relative to `/var/www/html`. |
| `unzip` | `url`, `to?` | Download a `.zip` (relative to the Blueprint path/URL or absolute) and extract it into `/var/www/html` (or `to`). |

## CMS-Specific Steps

- **Joomla (`--joomla`)**:
  - `setGlobalConfig` (`values`) — updates properties in `configuration.php`.
  - `runSql` (`sql`) — executes SQL statements against Joomla's database (supports `#__` table prefix).
- **WordPress (`--wp`)**:
  - `defineWpConfigConsts` (`consts`) — defines PHP constants in `wp-config.php`.
  - `setSiteOption` (`option`, `value`) — calls `update_option($option, $value)`.
  - `activatePlugin` (`pluginPath`) — calls `activate_plugin($pluginPath)` (e.g. `hello-dolly/hello.php`).

- **Drupal (`--drupal`)**:
  - `setSiteName` (`name`) — updates `system.site` `name` and flushes caches.
  - `enableModule` (`module`) — installs and enables a Drupal module by machine name.
  - `setAdminTheme` (`theme`) — installs and activates an admin theme (`system.theme.admin`) and sets `node.settings.use_admin_theme = true`.
  - `setFrontPage` (`path`) — updates `system.site` `page.front` (must start with `/`) and flushes caches.
- **TYPO3 (`--typo3`)**:
  - `setSiteName` (`name`) — updates `SYS.sitename` in `typo3conf/system/settings.php`.
  - `runSql` (`sql`) — executes SQL statements against TYPO3's configured SQLite database.
- **Kirby (`--kirby`)**:
  - `setSiteTitle` (`title`) — updates `Title:` in `content/site.txt`.
  - `createPage` (`slug`, optional `title`, `template`, `content`) — creates a flat-file page in `content/<slug>/<template>.txt`.

## CMS-Specific Pitfalls & Admin Content Recipes

When seeding Admin-editable content or mounting custom themes/extensions across CMSs, watch for these gotchas:

### Joomla 4–6
- **Workflow associations required for Admin visibility:** Seeding `#__content` via SQL alone leaves **Content → Articles** empty unless you also insert a matching row into `#__workflow_associations` with `extension = 'com_content.article'` and `stage_id = 1` (and `#__content_frontpage` if `featured = 1`).
- **Admin-editable metadata:** Prefer `com_fields` (`#__fields` + `#__fields_values`) over packing custom keys into the `attribs` JSON column so editors can view and edit fields directly in the Joomla Administrator UI.

### Drupal (`minimal` profile)
- **Frontpage vs. `/user/login`:** On stock `minimal` installs, `system.site` `page.front` defaults to `/user/login`, which causes a custom theme's `page--front.html.twig` to hijack the login screen (`path.matcher.isFrontPage()` evaluates to `true`). `@cms-playground/drupal` enables `claro`, `toolbar`, and `views` and sets `page.front` to `/node` by default; use `setFrontPage` to point it to a custom node or route.
- **Hidden fields on `/node/<id>/edit`:** When creating custom fields programmatically, `EntityFormDisplay::setComponent()` requires an explicit widget type (for example `string_textfield` or `string_textarea`) — omitting `'type'` leaves fields hidden on node edit forms.

### TYPO3 13
- **Randomized SQLite filename:** TYPO3 13 writes its SQLite database to `typo3conf/cms-<hash>.sqlite`. Never hardcode the filename — use the `runSql` Blueprint step or read `$settings['DB']['Connections']['Default']['path']` from `typo3conf/system/settings.php`.
- **Frontend bootstrapping & password policy:** Fresh installs can start without frontend TypoScript templates or `tt_content` records (check `pages`, `sys_template`, and `typo3conf/sites/`). If creating backend users manually in PHP, satisfy TYPO3 13's `PasswordPolicyValidator` (8+ chars with uppercase, lowercase, digit, and special character) and hash with `(new \TYPO3\CMS\Core\Crypto\PasswordHashing\BcryptPasswordHash())->getHashedPassword($password)` rather than raw `password_hash()`.

### WordPress
- **Content & Gutenberg-editable metadata:** Seed posts via `wp_insert_post()`, assign taxonomy terms with `wp_set_post_tags()` / `wp_set_object_terms()`, and store metadata via `update_post_meta()`. To make custom meta editable in the Gutenberg Block Editor and REST API, register it with `register_post_meta(..., ['show_in_rest' => true])`.

Run `cms-playground run-blueprint --joomla --blueprint=./blueprint.json --verbosity=debug` to trace each step during development.
