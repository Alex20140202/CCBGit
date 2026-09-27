/**
 * Language detection.
 *
 * highlight.js bundles 193 grammars, so the job here is mapping a path onto
 * one of them. The extension table below is deliberately wide: a repository
 * full of `.ex` files should not render as plain text just because nobody
 * thought of Elixir.
 */

/** File extension -> highlight.js language id. */
const EXTENSION_LANGUAGES = {
  // --- web ---------------------------------------------------------------
  '.html': 'xml', '.htm': 'xml', '.xhtml': 'xml', '.xht': 'xml',
  '.xml': 'xml', '.xsd': 'xml', '.xsl': 'xml', '.xslt': 'xml',
  '.svg': 'xml', '.plist': 'xml', '.rss': 'xml', '.atom': 'xml',
  '.vue': 'xml', '.svelte': 'xml', '.astro': 'xml', '.mjml': 'xml',
  '.jinja': 'django', '.jinja2': 'django', '.j2': 'django',
  '.njk': 'django', '.twig': 'django', '.liquid': 'django',
  '.hbs': 'handlebars', '.handlebars': 'handlebars', '.mustache': 'handlebars',
  '.ejs': 'javascript', '.pug': 'xml', '.jade': 'xml', '.haml': 'haml',
  '.erb': 'ruby', '.hamlc': 'haml',

  // --- css ----------------------------------------------------------------
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.styl': 'stylus', '.stylus': 'stylus', '.pcss': 'css', '.postcss': 'css',
  '.sss': 'css', '.acss': 'css',

  // --- javascript / typescript -------------------------------------------
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'javascript', '.es': 'javascript', '.es6': 'javascript',
  '.jsm': 'javascript', '.jsb': 'javascript', '.pac': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.cts': 'typescript', '.d.ts': 'typescript',
  '.coffee': 'coffeescript', '.litcoffee': 'coffeescript',
  '.ls': 'livescript', '._coffee': 'coffeescript',
  '.flow': 'javascript', '.json5': 'json', '.jsonc': 'json', '.jsonl': 'json',
  '.geojson': 'json', '.webmanifest': 'json', '.arcconfig': 'json',
  '.jsonnet': 'json', '.libsonnet': 'json',

  // --- jvm ----------------------------------------------------------------
  '.java': 'java', '.jsp': 'xml', '.jspx': 'xml', '.kt': 'kotlin',
  '.kts': 'kotlin', '.ktm': 'kotlin', '.scala': 'scala', '.sc': 'scala',
  '.groovy': 'groovy', '.gradle': 'groovy', '.gvy': 'groovy',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure', '.edn': 'clojure',
  '.cljx': 'clojure', '.boot': 'clojure',

  // --- c family -----------------------------------------------------------
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hxx': 'cpp', '.hh': 'cpp', '.h++': 'cpp',
  '.ipp': 'cpp', '.inl': 'cpp', '.tcc': 'cpp',
  '.swift': 'swift', '.m': 'objectivec', '.mm': 'objectivec',
  '.cs': 'csharp', '.csx': 'csharp', '.fs': 'fsharp', '.fsx': 'fsharp',
  '.fsi': 'fsharp', '.vb': 'vbnet', '.vbs': 'vbscript', '.bas': 'vbnet',
  '.d': 'd', '.di': 'd',

  // --- scripting ----------------------------------------------------------
  '.py': 'python', '.pyw': 'python', '.pyi': 'python', '.py3': 'python',
  '.pyx': 'python', '.pxd': 'python', '.pxi': 'python', '.pyt': 'python',
  '.rb': 'ruby', '.rbw': 'ruby', '.gemspec': 'ruby', '.ru': 'ruby',
  '.rake': 'ruby', '.podspec': 'ruby', '.thor': 'ruby',
  '.pl': 'perl', '.pm': 'perl', '.pod': 'perl', '.t': 'perl',
  '.php': 'php', '.php3': 'php', '.php4': 'php', '.php5': 'php',
  '.phps': 'php', '.phtml': 'php',
  '.lua': 'lua', '.tcl': 'tcl', '.r': 'r', '.rd': 'r', '.rmd': 'r',
  '.dart': 'dart', '.groovy': 'groovy',
  '.ex': 'elixir', '.exs': 'elixir', '.eex': 'elixir', '.leex': 'elixir',
  '.heex': 'elixir', '.erl': 'erlang', '.hrl': 'erlang', '.escript': 'erlang',
  '.hs': 'haskell', '.lhs': 'haskell', '.cabal': 'haskell',
  '.ml': 'ocaml', '.mli': 'ocaml', '.mll': 'ocaml', '.mly': 'ocaml',
  '.nim': 'nim', '.nims': 'nim', '.cr': 'crystal', '.zig': 'plaintext',
  '.v': 'verilog', '.sv': 'verilog', '.svh': 'verilog', '.vh': 'verilog',
  '.vhd': 'vhdl', '.vhdl': 'vhdl',

  // --- functional ---------------------------------------------------------
  '.fs': 'fsharp', '.fsscript': 'fsharp', '.fsx': 'fsharp', '.fsi': 'fsharp',
  '.jl': 'julia', '.ha': 'haxe', '.hx': 'haxe', '.hxml': 'haxe',
  '.purs': 'haskell', '.idr': 'plaintext', '.lidr': 'plaintext', '.agda': 'plaintext',
  '.re': 'reasonml', '.rei': 'reasonml',
  '.ll': 'llvm', '.llv': 'llvm',
  '.pony': 'pony', '.pro': 'prolog', '.plg': 'prolog', '.prolog': 'prolog',
  '.nix': 'nix', '.sml': 'sml', '.fun': 'sml', '.smlnj': 'sml',
  '.dpc': 'pascal', '.pas': 'pascal', '.lpr': 'pascal', '.p': 'python',
  '.dcr': 'diff', '.lmi': 'markdown', '.livemd': 'markdown',

  // --- systems ------------------------------------------------------------
  '.rlib': 'rust', '.rs': 'rust',
  '.go': 'go', '.s': 'armasm', '.asm': 'x86asm',
  '.f': 'fortran', '.f77': 'fortran', '.f90': 'fortran', '.f95': 'fortran',
  '.for': 'fortran', '.f03': 'fortran', '.f08': 'fortran',
  '.fth': 'fortran', '.pas': 'delphi', '.pp': 'pascal', '.dpr': 'delphi',
  '.ada': 'ada', '.adb': 'ada', '.ads': 'ada',
  '.adaadl': 'ada', '.adspec': 'ada',
  '.dsp': 'makefile', '.dsw': 'makefile',
  '.cu': 'cpp', '.cuh': 'cpp', '.cl': 'c',

  // --- shell / devops -----------------------------------------------------
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ksh': 'bash',
  '.csh': 'bash', '.login': 'bash', '.profile': 'bash', '.envrc': 'bash',
  '.env': 'bash', '.bashrc': 'bash', '.bash_profile': 'bash',
  '.bash_login': 'bash', '.bash_logout': 'bash', '.zshrc': 'bash',
  '.zprofile': 'bash', '.zshenv': 'bash', '.zlogin': 'bash', '.zlogout': 'bash',
  '.fish': 'bash', '.ps1': 'powershell', '.psm1': 'powershell',
  '.psd1': 'powershell', '.ps1xml': 'powershell', '.bat': 'batch',
  '.cmd': 'batch',
  '.awk': 'awk', '.sed': 'plaintext', '.tcl': 'tcl',
  '.mk': 'makefile', '.mak': 'makefile', '.make': 'makefile',
  '.cmake': 'cmake', '.dockerfile': 'dockerfile',
  '.tf': 'plaintext', '.tfvars': 'plaintext', '.hcl': 'plaintext',
  '.nomad': 'plaintext', '.bicep': 'plaintext',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'ini',
  '.editorconfig': 'ini', '.gitconfig': 'ini', '.npmrc': 'ini',
  '.nvmrc': 'plaintext', '.yarnrc': 'yaml', '.babelrc': 'json',
  '.toml': 'ini', '.tml': 'ini',
  '.service': 'ini', '.socket': 'ini', '.timer': 'ini',
  '.desktop': 'ini', '.policy': 'ini', '.rules': 'plaintext',
  '.env.production': 'bash', '.env.development': 'bash', '.env.test': 'bash',
  '.env.local': 'bash', '.env.staging': 'bash', '.env.example': 'bash',
  '.env.sample': 'bash', '.env.template': 'bash', '.env.dist': 'bash',
  '.apacheconf': 'apache', '.htaccess': 'apache', '.nginx': 'nginx',
  '.vhost': 'nginx', '.dosini': 'ini', '.editorconfig': 'ini',

  // --- data / config ------------------------------------------------------
  '.yml': 'yaml', '.yaml': 'yaml', '.yml.dist': 'yaml',
  '.json': 'json', '.jsonl': 'json', '.ndjson': 'json', '.avsc': 'json',
  '.csv': 'plaintext', '.tsv': 'plaintext', '.pcap': 'plaintext',
  '.proto': 'protobuf', '.thrift': 'plaintext', '.graphql': 'graphql',
  '.gql': 'graphql', '.sol': 'plaintext', '.avdl': 'plaintext',
  '.tfrecord': 'plaintext', '.msgpack': 'plaintext',

  // --- query / schema -----------------------------------------------------
  '.sql': 'sql', '.mysql': 'sql', '.psql': 'sql', '.plsql': 'sql',
  '.ddl': 'sql', '.dml': 'sql', '.pgsql': 'sql', '.hql': 'sql',
  '.prc': 'sql', '.prql': 'plaintext', '.cypher': 'plaintext',
  '.rq': 'plaintext', '.gql ': 'graphql',

  // --- docs / text --------------------------------------------------------
  '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown',
  '.mkd': 'markdown', '.mdx': 'markdown', '.mkdn': 'markdown',
  '.mdc': 'markdown', '.rmd': 'r',
  '.rst': 'plaintext', '.adoc': 'asciidoc', '.asciidoc': 'asciidoc',
  '.org': 'plaintext', '.texi': 'tex', '.tex': 'latex', '.latex': 'latex',
  '.bib': 'plaintext', '.bibtex': 'plaintext',
  '.txt': 'plaintext', '.text': 'plaintext', '.log': 'plaintext',
  '.man': 'plaintext', '.1': 'plaintext', '.2': 'plaintext', '.3': 'plaintext', '.nroff': 'plaintext',
  '.rtf': 'plaintext', '.srt': 'plaintext', '.vtt': 'plaintext',

  // --- editors / misc -----------------------------------------------------
  '.vim': 'vim', '.vimrc': 'vim', '.nvim': 'lua',
  '.el': 'lisp', '.lisp': 'lisp', '.lsp': 'lisp', '.scm': 'scheme',
  '.sc': 'scheme', '.ss': 'scheme', '.cl': 'c',
  '.rkt': 'scheme', '.rktd': 'scheme', '.rktl': 'scheme',
  '.tla': 'plaintext', '.lean': 'plaintext', '.thy': 'plaintext',
  '.rex': 'plaintext', '.r3': 'plaintext', '.reb': 'plaintext',
  '.gd': 'python', '.gdscript': 'python', '.tres': 'xml',
  '.tscn': 'xml', '.godot': 'ini', '.gdns': 'xml',
  '.sln': 'plaintext', '.csproj': 'xml', '.fsproj': 'xml',
  '.vcxproj': 'xml', '.props': 'xml', '.targets': 'xml',
  '.resx': 'xml', '.config': 'xml', '.nuspec': 'xml',
  '.podspec': 'ruby', '.gemspec': 'ruby',
  '.rdoc': 'plaintext', '.yardopts': 'ini',
  '.ttml': 'xml',
  '.diff': 'diff', ".patch": 'diff', ".rej": 'diff',
  // --- more that often show up in repositories ----------------------------
  '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl', '.geom': 'glsl',
  '.hlsl': 'plaintext', '.fx': 'plaintext', '.shader': 'plaintext',
  '.sas': 'sas', '.sps': 'plaintext',
  '.asc': 'armasm', '.neon': 'x86asm', '.nasm': 'x86asm',
  '.mips': 'mipsasm', '.spp': 'c', '.cxx-cc': 'cpp',
  '.gml': 'gml', '.yy': 'gml', '.yy.c': 'cpp', '.y': 'plaintext', '.yacc': 'plaintext',
  '.l': 'plaintext', '.lex': 'plaintext', '.llg': 'llvm',
  '.gn': 'plaintext', '.gni': 'plaintext', '.gninja': 'plaintext',
  '.scad': 'openscad', '.stl': 'plaintext',
  '.g4': 'plaintext', '.peg': 'plaintext', '.pegjs': 'plaintext',
  '.ne': 'c', '.w': 'c', '.cs2': 'csharp',
  '.sps1': 'plaintext', '.ahk': 'autohotkey', '.au3': 'autohotkey',
  '.applescript': 'applescript', '.scpt': 'applescript',
  '.xq': 'xquery', '.xql': 'xquery', '.xqm': 'xquery',
  '.m': 'objectivec', '.purs': 'haskell',
  '.thy': 'plaintext', '.als': 'plaintext', '.tla': 'plaintext',
  '.ecl': 'prolog', '.prolog ': 'prolog',
  '.ldif': 'ldif', '.rdn': 'ldif',
  '.gcode': 'gcode', '.nc': 'gcode', '.tap': 'gcode', '.ngc': 'gcode',
  '.step': 'step21', '.stp': 'step21', '.p21': 'step21',
  '.qml': 'qml', '.js.qml': 'qml',
  '.gams': 'gams', '.gms': 'gams',
  '.pro': 'prolog', '.rsl': 'rsl', '.rsl2': 'rsl',
  '.x': 'r', '.sas': 'sas',
  '.bas': 'vbnet', '.vba': 'vbnet', '.frm': 'vbnet', '.cls': 'vbnet',
  '.wsdl': 'xml', '.raml': 'yaml',
  '.rspec': 'yaml', '.simplecov': 'json',
  '.mustache': 'handlebars', '.dot': 'gherkin', '.feature': 'gherkin',
  '.puppet': 'puppet', '.pp': 'puppet',
  '.mo': 'ini', '.po': 'ini', '.pot': 'ini', '.lang': 'ini',

};

/**
 * Whole filenames that identify a language regardless of extension, plus the
 * dotfiles whose *name* is the tell.
 */
const FILENAME_LANGUAGES = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  rakefile: 'ruby',
  gemfile: 'ruby',
  brewfile: 'ruby',
  capfile: 'ruby',
  vagrantfile: 'ruby',
  guardfile: 'ruby',
  podfile: 'ruby',
  fastfile: 'ruby',
  appfile: 'ruby',
  'build.gradle': 'groovy',
  'settings.gradle': 'groovy',
  'gradle.properties': 'ini',
  'go.mod': 'go',
  'go.sum': 'plaintext',
  'cargo.toml': 'ini',
  'cargo.lock': 'ini',
  'package.json': 'json',
  'package-lock.json': 'json',
  'yarn.lock': 'plaintext',
  'pnpm-lock.yaml': 'yaml',
  'composer.json': 'json',
  'composer.lock': 'json',
  'pipfile': 'toml',
  'poetry.lock': 'toml',
  'gemfile.lock': 'plaintext',
  'requirements.txt': 'plaintext',
  'constraints.txt': 'plaintext',
  'manifest.in': 'python',
  'setup.py': 'python',
  'setup.cfg': 'ini',
  'pyproject.toml': 'toml',
  'tox.ini': 'ini',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.gitmodules': 'ini',
  '.gitconfig': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'yaml',
  '.nvmrc': 'plaintext',
  '.editorconfig': 'ini',
  '.env': 'bash',
  '.envrc': 'bash',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.bash_aliases': 'bash',
  '.profile': 'bash',
  '.zshrc': 'bash',
  '.zprofile': 'bash',
  '.zshenv': 'bash',
  '.vimrc': 'vim',
  '.gvimrc': 'vim',
  '.inputrc': 'plaintext',
  'makefile.am': 'makefile',
  'configure.ac': 'plaintext',
  'meson.build': 'python',
  'meson_options.txt': 'ini',
  'kconfig': 'plaintext',
  'jenkinsfile': 'groovy',
  'procfile': 'yaml',
  'berksfile': 'ruby',
  'thorfile': 'ruby',
  'policyfile.rb': 'ruby',
  'justfile': 'makefile',
  'earthfile': 'yaml',
  'vagrantfile': 'ruby',
  'nginx.conf': 'nginx',
  'apache2.conf': 'apache',
  'httpd.conf': 'apache',
  'phpunit.xml': 'xml',
  'phpstan.neon': 'yaml',
  '.babelrc': 'json',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.eslintrc.js': 'javascript',
  '.eslintrc.json': 'json',
  '.eslintrc.yml': 'yaml',
  '.swcrc': 'json',
  '.watchmanconfig': 'json',
  '.tern-project': 'json',
  '.clj-kondo': 'yaml',
  '.rspec': 'yaml',
  '.rspec_status': 'yaml',
  '.rubocop.yml': 'yaml',
  '.python-version': 'plaintext',
  '.node-version': 'plaintext',
  '.ruby-version': 'plaintext',
  '.tool-versions': 'ini',
  'mix.exs': 'elixir',
  'mix.lock': 'plaintext',
  'rebar.config': 'erlang',
  'stack.yaml': 'yaml',
  'cabal.project': 'haskell',
  'dune-project': 'plaintext',
  'shard.yml': 'yaml',
  'pubspec.yaml': 'yaml',
  'pubspec.lock': 'yaml',
  'bitbake': 'python',
};

/**
 * Candidate suffixes for a lowercased basename, longest first.
 *
 * `types.d.ts` -> ['.d.ts', '.ts']; `a.b.c.tar.gz` -> ['.b.c.tar.gz', '.c.tar.gz',
 * '.tar.gz', '.gz']. The final entry is always the last extension, so callers
 * can rely on a hit for anything that has one.
 */
function suffixChain(lower) {
  const out = [];
  let rest = lower;
  for (;;) {
    const index = rest.indexOf('.', 1);
    if (index === -1) break;
    rest = rest.slice(index);
    out.push(rest);
  }
  return out;
}

const MARKDOWN_NAMES = ['readme.md', 'readme.markdown', 'readme', 'readme.txt', 'readme.rst'];
const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd|mdc|mdx|rmd)$/i;
const PLAIN = 'plaintext';

/** Basename without a directory part. */
function basename(filePath) {
  return String(filePath || '').split('/').pop() || '';
}

/**
 * Best-effort language id for a file path, used for highlighting and stats.
 *
 * Never returns null: an unrecognised path becomes `plaintext`, which the
 * caller may then upgrade with content sniffing.
 */
export function languageFor(filePath) {
  const base = basename(filePath);
  const lower = base.toLowerCase();
  if (!base) return PLAIN;

  // 1. an exact filename match, e.g. "dockerfile" or "go.mod"
  if (FILENAME_LANGUAGES[lower]) return FILENAME_LANGUAGES[lower];

  // 2. a compound extension, resolved by peeling leading segments off the
  //    suffix chain: "types.d.ts" tries ".d.ts" then ".ts", "view.blade.php"
  //    tries ".blade.php" then ".php". The chain always shortens, so this
  //    terminates.
  //
  //    This runs before the filename-prefix rule on purpose: otherwise
  //    "README.md" would match the "readme" entry and lose its ".md".
  for (const suffix of suffixChain(lower)) {
    if (EXTENSION_LANGUAGES[suffix]) return EXTENSION_LANGUAGES[suffix];
  }

  // 3. a known stem with a suffix of its own, e.g. "dockerfile.prod" or
  //    "makefile.am" - but only when the suffix is not a known extension.
  for (const [name, language] of Object.entries(FILENAME_LANGUAGES)) {
    if (lower.length > name.length && lower.startsWith(`${name}.`)) return language;
  }

  // 4. the file's own name, for things like "Rakefile" that vary in case
  if (FILENAME_LANGUAGES[base]) return FILENAME_LANGUAGES[base];

  // 5. the last extension. Note the loop below walks the suffixes from longest
  //    to shortest, so "archive.tar.gz" is offered "gz" before "tar.gz".
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return PLAIN;
  return EXTENSION_LANGUAGES[lower.slice(dot)] || PLAIN;
}

/** The id highlight.js actually knows about, or null. */
export function knownLanguage(language) {
  return language && language !== PLAIN ? language : null;
}

export function isMarkdown(filePath) {
  const lower = basename(filePath).toLowerCase();
  return MARKDOWN_NAMES.includes(lower) || MARKDOWN_EXTENSION.test(lower);
}

export function isReadme(filePath) {
  return MARKDOWN_NAMES.includes(basename(filePath).toLowerCase());
}

export function isDiff(filePath) {
  return /\.(diff|patch|rej)$/.test(filePath.toLowerCase());
}

/** Directories whose contents are vendored, built, or otherwise not the
 *  repository's own code. */
const VENDORED_DIRS = /(^|\/)(node_modules|vendor|\.git|\.svn|\.hg|\.cache|dist|build|target|vendor_bundle|__pycache__|\.venv|venv|bower_components|jspm_packages|\.next|\.nuxt|coverage|htmlcov|\.pytest_cache|\.mypy_cache|cmake-build-debug|Pods|\.terraform)\//;

/**
 * Whether a path is worth counting in the language statistics.
 *
 * This deliberately does not consult an allow-list of extensions: an unknown
 * extension is far more likely to be source code in a language nobody has
 * listed than a binary blob, and the binary case is caught by the byte
 * inspection that happens when the file is read.
 */
export function isProbablyText(filePath) {
  const raw = String(filePath || '');
  const lower = basename(raw).toLowerCase();
  if (!lower) return false;

  // Vendored, generated or hidden: not this repository's own source.
  if (VENDORED_DIRS.test(raw)) return false;
  if (/(^|\/)\.[^/.]+/.test(raw)) return false;

  const KNOWN_BINARY = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'heic',
    'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war',
    'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'm4v', 'mov', 'avi',
    'mkv', 'webm', 'wmv',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'exe', 'dll', 'so', 'dylib', 'o', 'a', 'obj', 'lib', 'class', 'pyc', 'pyo',
    'wasm', 'node', 'bin', 'dat', 'db', 'sqlite', 'sqlite3',
    'ds_store', 'icns', 'keystore', 'jks', 'p12', 'pfx', 'crt', 'der',
  ]);

  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    // No extension at all: licence files, READMEs, Makefile, scripts.
    return !lower.startsWith('.');
  }
  return !KNOWN_BINARY.has(lower.slice(dot + 1));
}

/** Human readable byte size. */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

/**
 * Distinct colours for the language bar, stable per language name.
 *
 * The palette is ordered so that adjacent entries in a typical repository mix
 * stay distinguishable rather than landing on two shades of the same hue.
 */
const PALETTE = [
  '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd',
  '#56b6c2', '#d19a66', '#7fdbca', '#f2777a', '#a6e3a1',
  '#f9e2af', '#7cc4f8', '#d8a8f0', '#8ad7d1',
];

/** Colour for a language, derived from its name so it never changes. */
export function languageColor(language) {
  let hash = 0;
  for (let i = 0; i < String(language).length; i += 1) {
    hash = (hash * 31 + String(language).charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/** Extensions covered by the table above; used by the tests. */
export const KNOWN_EXTENSIONS = Object.keys(EXTENSION_LANGUAGES);
export { EXTENSION_LANGUAGES, FILENAME_LANGUAGES };
