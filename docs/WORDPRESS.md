# WordPress integration (flexplaying.com)

Hostinger inspection (via the Hostinger connector) found:

- WordPress install `10083087` at `https://flexplaying.com`, plus a separate install on `minecraft.flexplaying.com`.
- Active plugins relevant to EditorialOS: **Yoast SEO 28.8**, **Classic Editor**, Elementor, LiteSpeed Cache, Imagify, WPCode Lite, Site Kit by Google.
- Theme: Benqu.
- **Security note:** WP Rocket 3.12 is installed but inactive and has known vulnerabilities (XSS, broken access control, DoS; fixed in 3.23.5+). Delete it if you don't use it. EditorialOS does not change plugins.

## 1. Create a dedicated user and Application Password

1. WordPress admin → **Users → Add New**: create a user such as `editorialos` with the **Editor** role. Editor can create drafts, publish, upload media and create tags. Use **Author** if you want drafts and own-post publishing only, without tag creation.
2. Log in as that user (or edit them as an admin) → **Users → Profile → Application Passwords**, enter the name `EditorialOS`, then **Add New Application Password**.
3. Copy the 24-character password. It is shown once. Paste it into **EditorialOS → Settings → WordPress**, along with the username.

The password is sent only to the server, tested against `/wp-json/wp/v2/users/me`, encrypted with AES-256-GCM (bound to the workspace ID), and never shown again. To rotate it, create a new Application Password, paste it into Settings, then revoke the old one in WordPress. Disconnecting deletes the stored credential and pauses automation.

If Application Passwords are missing from the profile page, a security plugin or the host may have disabled them, or the site is not served over HTTPS. Re-enable them before connecting.

## 2. Categories

EditorialOS publishes into exactly three categories. On connection it auto-maps WordPress categories whose slug or name is `anime`, `gaming` or `esports`. Check the mapping in **Settings → WordPress**. If a category is not mapped, publishing stops with `category_unmapped` rather than guessing.

## 3. Yoast SEO fields (optional)

Yoast stores the SEO title, meta description and focus keyphrase in protected post meta, which is not exposed to the REST API by default. Without changes, EditorialOS still sends these fields, then verifies against `yoast_head_json`. It reports `not_writable` when they were ignored, in which case Yoast falls back to the post excerpt (which EditorialOS sets to a meta-description-quality summary).

To let EditorialOS write them, add this PHP snippet with **WPCode Lite** (already installed): **Code Snippets → Add Snippet → PHP**, set it to run everywhere. Review it yourself first; EditorialOS will not install it for you.

```php
add_action( 'init', function () {
    foreach ( array( '_yoast_wpseo_title', '_yoast_wpseo_metadesc', '_yoast_wpseo_focuskw' ) as $key ) {
        register_post_meta( 'post', $key, array(
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function () { return current_user_can( 'edit_posts' ); },
        ) );
    }
} );
```

After that, new articles show `SEO plugin sync: yoast — written` on their detail page.

## 4. What EditorialOS does on WordPress

| Operation | Endpoint |
|---|---|
| Connection test, plugin detection | `GET /wp-json/`, `GET /wp/v2/users/me?context=edit` |
| Duplicate checks | `GET /wp/v2/posts?status=publish,future,draft,pending,private&context=edit` (paginated via `X-WP-TotalPages`) plus targeted `search=` queries |
| Thumbnails | `POST /wp/v2/media`, `POST /wp/v2/media/{id}` (alt text, title) |
| Tags | `GET/POST /wp/v2/tags` |
| Articles | `POST /wp/v2/posts` (draft or publish), `POST /wp/v2/posts/{id}`, then `GET` read-back |

It never deletes posts, changes users, installs plugins or modifies settings. If a post already exists for an article (matched by its hidden marker), it is updated rather than duplicated, and a post a human has already published is never downgraded to a draft.

LiteSpeed Cache and Imagify act on new posts and media as usual. If a security plugin rate-limits the REST API, EditorialOS retries with backoff and records the error.
