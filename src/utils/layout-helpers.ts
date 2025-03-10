import * as memoize from 'memoizee';
import * as walkSync from 'walk-sync';
import * as fs from 'fs';
import * as fg from 'fast-glob';
import * as path from 'path';
import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { Project } from '../project';
import { addToRegistry, normalizeMatchNaming } from './registry-api';
import { clean, coerce, valid } from 'semver';
import { normalizeToClassicComponent } from '../utils/normalizers';

// const GLOBAL_REGISTRY = ['primitive-name'][['relatedFiles']];

export const ADDON_CONFIG_KEY = 'ember-language-server';

export function normalizeRoutePath(name: string) {
  return name.split('/').join('.');
}

export function hasEmberLanguageServerExtension(info: PackageInfo) {
  return info[ADDON_CONFIG_KEY] !== undefined;
}

export const isModuleUnificationApp = memoize(isMuApp, {
  length: 1,
  maxAge: 60000,
});
export const podModulePrefixForRoot = memoize(getPodModulePrefix, {
  length: 1,
  maxAge: 60000,
});
export const mGetProjectAddonsInfo = memoize(getProjectAddonsInfo, {
  length: 2,
  maxAge: 600000,
}); // 1 second

const mProjectAddonsRoots = memoize(getProjectAddonsRoots, {
  length: 1,
  maxAge: 600000,
});
const mProjectInRepoAddonsRoots = memoize(getProjectInRepoAddonsRoots, {
  length: 1,
  maxAge: 600000,
});

export const isAddonRoot = memoize(isProjectAddonRoot, {
  length: 1,
  maxAge: 600000,
});

type UnknownConfig = Record<string, unknown>;
type StringConfig = Record<string, string>;

export interface PackageInfo {
  keywords?: string[];
  name?: string;
  'ember-language-server'?: UnknownConfig;
  peerDependencies?: StringConfig;
  devDependencies?: StringConfig;
  dependencies?: StringConfig;
  workspaces?: string[];
  'ember-addon'?: {
    version?: number;
    projectRoot?: string;
    paths?: string[];
    before?: string | string[];
    after?: string | string[];
  };
}

export function isMuApp(root: string) {
  return fs.existsSync(path.join(root, 'src', 'ui'));
}

export function safeWalkSync(filePath: string | false, opts: any) {
  if (!filePath) {
    return [];
  }

  if (!fs.existsSync(filePath)) {
    return [];
  }

  return walkSync(filePath, opts);
}

export function getPodModulePrefix(root: string): string | null {
  let podModulePrefix = '';

  // log('listPodsComponents');
  try {
    // @ts-expect-error @todo - fix webpack imports
    const requireFunc = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appConfig = requireFunc(path.join(root, 'config', 'environment.js'));

    // log('appConfig', appConfig);
    podModulePrefix = appConfig('development').podModulePrefix || '';

    if (podModulePrefix.includes('/')) {
      podModulePrefix = podModulePrefix.split('/').pop() as string;
    }
  } catch (e) {
    // log('catch', e);
    return null;
  }

  if (!podModulePrefix) {
    return null;
  }

  return podModulePrefix.trim().length > 0 ? podModulePrefix : null;
}

export function resolvePackageRoot(root: string, addonName: string, packagesFolder = 'node_modules') {
  const roots = root.split(path.sep);

  while (roots.length) {
    const prefix = roots.join(path.sep);
    const maybePath = path.join(prefix, packagesFolder, addonName);
    const linkedPath = path.join(prefix, addonName);

    if (fs.existsSync(path.join(maybePath, 'package.json'))) {
      return maybePath;
    } else if (fs.existsSync(path.join(linkedPath, 'package.json'))) {
      return linkedPath;
    }

    roots.pop();
  }

  return false;
}

/**
 * Returns true if file path starts with the given root path.
 * There are cases where the root path might be
 * 'foo/bar/biz' and 'foo/bar/biz-bar'. The startsWith/includes will always
 * return true for both these roots. Hence having a stricter check will help
 * @param rootPath root path
 * @param filePath file path
 * @returns boolean
 */
export function isRootStartingWithFilePath(rootPath: string, filePath: string) {
  const filePathParts = normalizedPath(filePath).split('/');
  const rootParts = normalizedPath(rootPath).split('/');

  return rootParts.every((item: string, idx: number) => filePathParts[idx] === item);
}

export function isProjectAddonRoot(root: string) {
  const pack = getPackageJSON(root);
  const hasIndexJs = fs.existsSync(path.join(root, 'index.js'));

  return isEmberAddon(pack) && hasIndexJs;
}

export function isELSAddonRoot(root: string) {
  const pack = getPackageJSON(root);

  return hasEmberLanguageServerExtension(pack);
}

export function cached(_proto: unknown, prop: string, desc: PropertyDescriptor) {
  const values = new WeakMap();

  return {
    get() {
      if (!values.has(this)) {
        values.set(this, {});
      }

      const objects = values.get(this);

      if (!(prop in objects)) {
        objects[prop] = desc.get?.call(this);
      }

      return objects[prop];
    },
  };
}

function getRecursiveInRepoAddonRoots(root: string, roots: string[]) {
  const packageData = getPackageJSON(root);
  const emberAddonPaths: string[] = (packageData['ember-addon'] && packageData['ember-addon'].paths) || [];

  if (roots.length) {
    if (!isEmberAddon(packageData)) {
      return [];
    }
  }

  const recursiveRoots: string[] = roots.slice(0);

  emberAddonPaths
    .map((relativePath) => path.normalize(path.join(root, relativePath)))
    .filter((packageRoot: string) => {
      return isProjectAddonRoot(packageRoot);
    })
    .forEach((validRoot: string) => {
      const packInfo = getPackageJSON(validRoot);

      // we don't need to go deeper if package itself not an ember-addon or els-extension
      if (!isEmberAddon(packInfo) && !hasEmberLanguageServerExtension(packInfo)) {
        return;
      }

      if (!recursiveRoots.includes(validRoot)) {
        recursiveRoots.push(validRoot);
        getRecursiveInRepoAddonRoots(validRoot, recursiveRoots).forEach((relatedRoot: string) => {
          if (!recursiveRoots.includes(relatedRoot)) {
            recursiveRoots.push(relatedRoot);
          }
        });
      }
    });

  return recursiveRoots.sort();
}

export function getProjectInRepoAddonsRoots(root: string) {
  const roots: string[] = [];

  if (isModuleUnificationApp(root)) {
    const prefix = 'packages';
    const addons = safeWalkSync(path.join(root, prefix), {
      directories: true,
      globs: ['**/package.json'],
    });

    addons
      .map((relativePath: string) => {
        return path.dirname(path.join(root, prefix, relativePath));
      })
      .filter((packageRoot: string) => isProjectAddonRoot(packageRoot))
      .forEach((validRoot: string) => {
        roots.push(validRoot);
        getProjectAddonsRoots(validRoot, roots).forEach((relatedRoot: string) => {
          if (!roots.includes(relatedRoot)) {
            roots.push(relatedRoot);
          }
        });
      });
  } else {
    getRecursiveInRepoAddonRoots(root, []).forEach((resolvedRoot) => {
      if (!roots.includes(resolvedRoot)) {
        roots.push(resolvedRoot);
      }
    });
  }

  return roots;
}

export function listGlimmerXComponents(root: string): CompletionItem[] {
  try {
    const jsPaths = safeWalkSync(root, {
      directories: false,
      globs: ['**/*.{js,ts,jsx,hbs}'],
      ignore: ['dist', 'lib', 'node_modules', 'tmp', 'cache', '.*', '.cache', '.git', '.*.{js,ts,jsx,hbs,gbx}'],
    });

    return jsPaths
      .map((p) => {
        const fileName = p.split('/').pop();

        if (fileName === undefined) {
          return '';
        }

        return fileName.slice(0, fileName.lastIndexOf('.'));
      })
      .filter((p) => {
        return p.length && p.charAt(0) === p.charAt(0).toUpperCase() && !p.endsWith('-test') && !p.endsWith('.test');
      })
      .map((name) => {
        return {
          kind: CompletionItemKind.Class,
          label: name,
          detail: 'component',
        };
      });
  } catch (e) {
    return [];
  }
}

function hasDep(pack: PackageInfo, depName: string) {
  if (pack.dependencies && pack.dependencies[depName]) {
    return true;
  }

  if (pack.devDependencies && pack.devDependencies[depName]) {
    return true;
  }

  if (pack.peerDependencies && pack.peerDependencies[depName]) {
    return true;
  }

  return false;
}

export function getDepIfExists(pack: PackageInfo, depName: string): string | null {
  if (!hasDep(pack, depName)) {
    return null;
  }

  const version: string = pack?.dependencies?.[depName] ?? pack?.devDependencies?.[depName] ?? pack?.peerDependencies?.[depName] ?? '';

  const cleanVersion = clean(version);

  return valid(coerce(cleanVersion));
}

export function isGlimmerNativeProject(root: string) {
  const pack = getPackageJSON(root);

  return hasDep(pack, 'glimmer-native');
}

export function isGlimmerXProject(root: string) {
  const pack = getPackageJSON(root);

  return hasDep(pack, '@glimmerx/core') || hasDep(pack, 'glimmer-lite-core');
}

export function getProjectAddonsRoots(root: string, resolvedItems: string[] = [], packageFolderName = 'node_modules') {
  let pack = getPackageJSON(root);
  const maybeRoot = pack['ember-addon']?.projectRoot;

  // in case there is a different project root from the current one, then use that to get the dependencies.
  if (!isEmberAddon(pack) && maybeRoot) {
    const newRoot = path.join(root, maybeRoot);

    pack = getPackageJSON(newRoot);
  }

  if (resolvedItems.length) {
    if (!isEmberAddon(pack)) {
      return [];
    }
  }

  // log('getPackageJSON', pack);
  const items = resolvedItems.length
    ? [...Object.keys(pack.dependencies || {}), ...Object.keys(pack.peerDependencies || {})]
    : [...Object.keys(pack.dependencies || {}), ...Object.keys(pack.peerDependencies || {}), ...Object.keys(pack.devDependencies || {})];
  // log('items', items);

  const roots = items
    .map((item: string) => {
      return resolvePackageRoot(root, item, packageFolderName);
    })
    .filter((p: string | boolean) => {
      return p !== false;
    });
  const recursiveRoots: string[] = resolvedItems.slice(0);

  roots.forEach((rootItem: string) => {
    const packInfo = getPackageJSON(rootItem);

    // we don't need to go deeper if package itself not an ember-addon or els-extension
    if (!isEmberAddon(packInfo) && !hasEmberLanguageServerExtension(packInfo)) {
      return;
    }

    if (!recursiveRoots.includes(rootItem)) {
      recursiveRoots.push(rootItem);
      getProjectAddonsRoots(rootItem, recursiveRoots, packageFolderName).forEach((item: string) => {
        if (!recursiveRoots.includes(item)) {
          recursiveRoots.push(item);
        }
      });
    }
  });

  return recursiveRoots;
}

export function getPackageJSON(file: string): PackageInfo {
  try {
    const result = JSON.parse(fs.readFileSync(path.join(file, 'package.json'), 'utf8'));

    return result;
  } catch (e) {
    return {};
  }
}

/**
 * Returns the name of the module from index.js file.
 * @param file string
 */
export function getModuleNameFromIndexJS(file: string): string {
  try {
    const data = fs.readFileSync(path.join(file, 'index.js'), 'utf8');
    const regex = /(.*) moduleName(.*) '(.*)'(.*)/i;
    const found = data.match(regex);

    return found && found.length ? found[3] : '';
  } catch (e) {
    return '';
  }
}

export function isEmberAddon(info: PackageInfo) {
  return info.keywords && info.keywords.includes('ember-addon');
}

export function addonVersion(info: PackageInfo) {
  if (!isEmberAddon(info)) {
    return null;
  }

  return isEmberAddonV2(info) ? 2 : 1;
}

function isEmberAddonV2(info: PackageInfo) {
  return info['ember-addon'] && info['ember-addon'].version === 2;
}

export function isTemplatePath(filePath: string) {
  return filePath.endsWith('.hbs');
}

export function normalizedPath(filePath: string) {
  if (filePath.includes('\\')) {
    return filePath.split('\\').join('/');
  } else {
    return filePath;
  }
}

export function isTestFile(filePath: string) {
  return normalizedPath(filePath).includes('/tests/');
}

export function hasAddonFolderInPath(name: string) {
  return name.includes(path.sep + 'addon' + path.sep) || name.includes(path.sep + 'addon-test-support' + path.sep);
}

export function getProjectAddonsInfo(root: string, textPrefix?: string, includeModules?: string[], disableInit?: boolean) {
  if (textPrefix) {
    return findByGlob(root, textPrefix, includeModules);
  }

  if (!disableInit) {
    const roots = ([] as string[])
      .concat(mProjectAddonsRoots(root), mProjectInRepoAddonsRoots(root))
      .filter((pathItem: unknown) => typeof pathItem === 'string');
    // log('roots', roots);
    const meta: CompletionItem[][] = [];

    roots.forEach((packagePath: string) => {
      const info = getPackageJSON(packagePath);
      // log('info', info);
      const version = addonVersion(info);

      if (version === null) {
        return;
      }

      if (version === 1) {
        const extractedData = [
          ...listComponents(packagePath),
          ...listRoutes(packagePath),
          ...listHelpers(packagePath),
          ...listModels(packagePath),
          ...listTransforms(packagePath),
          ...listServices(packagePath),
          ...listModifiers(packagePath),
        ];

        // log('extractedData', extractedData);
        if (extractedData.length) {
          meta.push(extractedData);
        }
      }
    });

    const normalizedResult: CompletionItem[] = meta.reduce((arrs: CompletionItem[], item: CompletionItem[]) => {
      if (!item.length) {
        return arrs;
      }

      return arrs.concat(item);
    }, []);

    return normalizedResult;
  }
}

export function pureComponentName(relativePath: string) {
  const ext = path.extname(relativePath); // .hbs

  if (relativePath.startsWith('/')) {
    relativePath = relativePath.slice(1);
  }

  if (relativePath.endsWith(`/template${ext}`)) {
    return relativePath.replace(`/template${ext}`, '');
  } else if (relativePath.endsWith(`/component${ext}`)) {
    return relativePath.replace(`/component${ext}`, '');
  } else if (relativePath.endsWith(`/helper${ext}`)) {
    return relativePath.replace(`/helper${ext}`, '');
  } else if (relativePath.endsWith(`/index${ext}`)) {
    return relativePath.replace(`/index${ext}`, '');
  } else if (relativePath.endsWith(`/styles${ext}`)) {
    return relativePath.replace(`/styles${ext}`, '');
  } else {
    return relativePath.replace(ext, '');
  }
}

export function listPodsComponents(root: string): CompletionItem[] {
  const podModulePrefix = podModulePrefixForRoot(root);

  if (podModulePrefix === null) {
    return [];
  }

  const entryPath = path.resolve(path.join(root, 'app', podModulePrefix, 'components'));

  const jsPaths = safeWalkSync(entryPath, {
    directories: false,
    globs: ['**/*.{js,ts,hbs,css,less,scss}'],
  });

  const items = jsPaths.map((filePath: string) => {
    addToRegistry(pureComponentName(filePath), 'component', [path.join(entryPath, filePath)]);

    return {
      kind: CompletionItemKind.Class,
      label: pureComponentName(filePath),
      detail: 'component',
    };
  });

  // log('pods-items', items);
  return items;
}

export function listMUComponents(root: string): CompletionItem[] {
  const entryPath = path.resolve(path.join(root, 'src', 'ui', 'components'));
  const jsPaths = safeWalkSync(entryPath, {
    directories: false,
    globs: ['**/*.{js,ts,hbs}'],
  });

  const items = jsPaths.map((filePath: string) => {
    addToRegistry(pureComponentName(filePath), 'component', [path.join(entryPath, filePath)]);

    return {
      kind: CompletionItemKind.Class,
      label: pureComponentName(filePath),
      detail: 'component',
    };
  });

  return items;
}

export function builtinModifiers(): CompletionItem[] {
  return [
    {
      kind: CompletionItemKind.Method,
      label: 'action',
      detail: 'modifier',
    },
  ];
}

export function hasNamespaceSupport(root: string) {
  const pack = getPackageJSON(root);

  return hasDep(pack, 'ember-holy-futuristic-template-namespacing-batman');
}

export function listComponents(_root: string): CompletionItem[] {
  // log('listComponents');
  const root = path.resolve(_root);
  const scriptEntry = path.join(root, 'app', 'components');
  const templateEntry = path.join(root, 'app', 'templates', 'components');
  const addonComponents = path.join(root, 'addon', 'components');
  const addonTemplates = path.join(root, 'addon', 'templates', 'components');
  const addonComponentsPaths = safeWalkSync(addonComponents, {
    directories: false,
    globs: ['**/*.{js,ts,hbs}'],
  });
  const addonTemplatesPaths = safeWalkSync(addonTemplates, {
    directories: false,
    globs: ['**/*.{js,ts,hbs}'],
  });

  addonComponentsPaths.forEach((p) => {
    addToRegistry(pureComponentName(p), 'component', [path.join(addonComponents, p)]);
  });
  addonTemplatesPaths.forEach((p) => {
    addToRegistry(pureComponentName(p), 'component', [path.join(addonTemplates, p)]);
  });

  const jsPaths = safeWalkSync(scriptEntry, {
    directories: false,
    globs: ['**/*.{js,ts,hbs,css,less,scss}'],
  });

  jsPaths.forEach((p) => {
    addToRegistry(pureComponentName(p), 'component', [path.join(scriptEntry, p)]);
  });

  const hbsPaths = safeWalkSync(templateEntry, {
    directories: false,
    globs: ['**/*.hbs'],
  });

  hbsPaths.forEach((p) => {
    addToRegistry(pureComponentName(p), 'component', [path.join(templateEntry, p)]);
  });

  const paths = [...jsPaths, ...hbsPaths, ...addonComponentsPaths, ...addonTemplatesPaths];

  const items = paths.map((filePath: string) => {
    const label = pureComponentName(filePath);

    return {
      kind: CompletionItemKind.Class,
      label,
      detail: 'component',
    };
  });

  return items;
}

function findByGlob(root: string, textPrefix: string, includeModules?: string[]) {
  const isNameSpaced = hasNamespaceSupport(root);
  const prefixData = normalizeToClassicComponent(textPrefix.split('$')[0]);
  let paths = [];

  if (isNameSpaced) {
    paths = fg.sync(
      [`${root}/(lib|engines)/${prefixData}*/addon/templates/components/**/*.{js,hbs}`, `${root}/(lib|engines)/${prefixData}*/addon/components/**/*.{js,hbs}`],
      { ignore: ['**/node_modules/**'] }
    );

    if (!paths.length && includeModules && includeModules.length) {
      const modules = includeModules.length === 1 ? includeModules[0] : `(${includeModules.join('|')})`;

      paths = fg.sync([
        `${root}/node_modules/${modules}/*${prefixData}*/addon/templates/components/**/*.{js,hbs}`,
        `${root}/node_modules/${modules}/*${prefixData}*/addon/components/**/*.{js,hbs}`,
      ]);
    }
  } else {
    paths = fg.sync(
      [
        `${root}/(lib|engines)/**/addon/templates/components/**/${prefixData}*.{js,hbs}`,
        `${root}/(lib|engines)/**/addon/components/**/${prefixData}*.{js,hbs}`,
      ],
      { ignore: ['**/node_modules/**'] }
    );

    if (!paths.length && includeModules && includeModules.length) {
      const modules = includeModules.length === 1 ? includeModules[0] : `(${includeModules.join('|')})`;

      paths = fg.sync([
        `${root}/node_modules/${modules}/**/addon/templates/components/**/${prefixData}*.{js,hbs}`,
        `${root}/node_modules/${modules}/**/addon/components/**/${prefixData}*.{js,hbs}`,
      ]);
    }
  }

  const items = paths.map((filePath: string) => {
    const templateSplit = filePath.split('/templates/components/');
    let label = '';

    if (templateSplit.length > 1) {
      label = pureComponentName(templateSplit[1]);
    } else {
      const componentSplit = filePath.split('/components/');

      if (componentSplit.length > 1) {
        label = pureComponentName(componentSplit[1]);
      }
    }

    const addonRoot = filePath.split('/addon/')[0];
    const info = getPackageJSON(addonRoot);

    if (info && info.name && isNameSpaced) {
      // Since the addon name can be different from the folder name, get the name of the addon from the index.js.
      const addonModuleName = getModuleNameFromIndexJS(addonRoot);
      const rootNameParts = info.name.split('/');
      const addonName = addonModuleName || rootNameParts.pop() || '';

      label = `${addonName}$${label}`;
    }

    return {
      kind: CompletionItemKind.Class,
      label,
      detail: 'component',
    };
  });

  return items;
}

function findRegistryItemsForProject(project: Project, prefix: string, globs: string[]): void {
  const entry = path.resolve(path.join(project.root, prefix));
  const paths = safeWalkSync(entry, {
    directories: false,
    globs,
  });

  paths.forEach((filePath: string) => {
    const fullPath = path.join(entry, filePath);
    const item = project.matchPathToType(fullPath);

    if (item) {
      const normalizedItem = normalizeMatchNaming(item);

      addToRegistry(normalizedItem.name, normalizedItem.type, [fullPath]);
    }
  });
}

export function findTestsForProject(project: Project) {
  findRegistryItemsForProject(project, 'tests', ['**/*.{js,ts}']);
}

export function findAppItemsForProject(project: Project) {
  findRegistryItemsForProject(project, 'app', ['**/*.{js,ts,css,less,sass,hbs}']);
}

export function findAddonItemsForProject(project: Project) {
  findRegistryItemsForProject(project, 'addon', ['**/*.{js,ts,css,less,sass,hbs}']);
}

function listCollection(
  root: string,
  prefix: 'app' | 'addon',
  collectionName: 'transforms' | 'modifiers' | 'services' | 'models' | 'helpers',
  kindType: CompletionItemKind,
  detail: 'transform' | 'service' | 'model' | 'helper' | 'modifier'
) {
  const entry = path.resolve(path.join(root, prefix, collectionName));
  const paths = safeWalkSync(entry, {
    directories: false,
    globs: ['**/*.{js,ts}'],
  });

  const items = paths.map((filePath: string) => {
    addToRegistry(pureComponentName(filePath), detail, [path.join(entry, filePath)]);

    return {
      kind: kindType,
      label: pureComponentName(filePath),
      detail,
    };
  });

  return items;
}

export function listModifiers(root: string): CompletionItem[] {
  return listCollection(root, 'app', 'modifiers', CompletionItemKind.Function, 'modifier');
}

export function listModels(root: string): CompletionItem[] {
  return listCollection(root, 'app', 'models', CompletionItemKind.Class, 'model');
}

export function listServices(root: string): CompletionItem[] {
  return listCollection(root, 'app', 'services', CompletionItemKind.Class, 'service');
}

export function listHelpers(root: string): CompletionItem[] {
  return listCollection(root, 'app', 'helpers', CompletionItemKind.Function, 'helper');
}

export function listTransforms(root: string): CompletionItem[] {
  return listCollection(root, 'app', 'transforms', CompletionItemKind.Function, 'transform');
}

export function listRoutes(_root: string): CompletionItem[] {
  const root = path.resolve(_root);
  const scriptEntry = path.join(root, 'app', 'routes');
  const templateEntry = path.join(root, 'app', 'templates');
  const controllersEntry = path.join(root, 'app', 'controllers');
  const paths = safeWalkSync(scriptEntry, {
    directories: false,
    globs: ['**/*.{js,ts}'],
  });

  const templatePaths = safeWalkSync(templateEntry, {
    directories: false,
    globs: ['**/*.hbs'],
  }).filter((name: string) => {
    const skipEndings = ['-loading', '-error', '/loading', '/error'];

    return !name.startsWith('components/') && skipEndings.filter((ending: string) => name.endsWith(ending + '.hbs')).length === 0;
  });

  const controllers = safeWalkSync(controllersEntry, {
    directories: false,
    globs: ['**/*.{js,ts}'],
  });

  let items: any[] = [];

  items = items.concat(
    templatePaths.map((filePath) => {
      const label = filePath.replace(path.extname(filePath), '').replace(/\//g, '.');

      addToRegistry(label, 'routePath', [path.join(templateEntry, filePath)]);

      return {
        kind: CompletionItemKind.File,
        label,
        detail: 'route',
      };
    })
  );

  items = items.concat(
    paths.map((filePath) => {
      const label = filePath.replace(path.extname(filePath), '').replace(/\//g, '.');

      addToRegistry(label, 'routePath', [path.join(scriptEntry, filePath)]);

      return {
        kind: CompletionItemKind.File,
        label,
        detail: 'route',
      };
    })
  );

  controllers.forEach((filePath) => {
    const label = filePath.replace(path.extname(filePath), '').replace(/\//g, '.');

    addToRegistry(label, 'routePath', [path.join(controllersEntry, filePath)]);
  });

  return items;
}

export function getComponentNameFromURI(root: string, uri: string) {
  const fileName = uri.replace('file://', '').replace(root, '');
  const splitter = fileName.includes(path.sep + '-components' + path.sep) ? '/-components/' : '/components/';
  const maybeComponentName = fileName.split(path.sep).join('/').split(splitter)[1];

  if (!maybeComponentName) {
    return null;
  }

  return pureComponentName(maybeComponentName);
}
