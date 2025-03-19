// Things this script does

// Validates
// - The manifest
// - The markdown files contents (including frontmatter)
// - Links (including hashes) between docs are valid
// - The sdk filtering in the manifest
// - The sdk filtering in the frontmatter
// - The sdk filtering in the <If /> component
//   - Checks that the sdk is available in the manifest
//   - Checks that the sdk is available in the frontmatter

// - Embeds the includes in the markdown files
// - Updates the links in the content if they point to the sdk specific docs
// - Copies over "core" docs to the dist folder
// - Generates "landing" pages for the sdk specific docs at the original url
// - Generates a manifest that is specific to each SDK
// - Duplicates out the sdk specific docs to their respective folders
//   - stripping filtered out content
// - Removes .mdx from the end of docs markdown links

import fs from 'node:fs/promises'
import path from 'node:path'
import remarkMdx from 'remark-mdx'
import { remark } from 'remark'
import { visit as mdastVisit } from 'unist-util-visit'
import { filter as mdastFilter } from 'unist-util-filter'
import { map as mdastMap } from 'unist-util-map'
import { u as mdastBuilder } from 'unist-builder'
import remarkFrontmatter from 'remark-frontmatter'
import yaml from 'yaml'
import { slugifyWithCounter } from '@sindresorhus/slugify'
import { toString } from 'mdast-util-to-string'
import reporter from 'vfile-reporter'
import readdirp from 'readdirp'
import { z } from 'zod'
import { fromError } from 'zod-validation-error'
import { Node } from 'unist'
import watcher from '@parcel/watcher'

const VALID_SDKS = [
  'nextjs',
  'react',
  'javascript-frontend',
  'chrome-extension',
  'expo',
  'ios',
  'nodejs',
  'expressjs',
  'fastify',
  'react-router',
  'remix',
  'tanstack-start',
  'go',
  'astro',
  'nuxt',
  'vue',
  'ruby',
  'python',
  'javascript-backend',
  'sdk-development',
  'community-sdk',
] as const

type SDK = (typeof VALID_SDKS)[number]

const sdk = z.enum(VALID_SDKS)

const icon = z.enum([
  'apple',
  'application-2',
  'arrow-up-circle',
  'astro',
  'angular',
  'block',
  'bolt',
  'book',
  'box',
  'c-sharp',
  'chart',
  'checkmark-circle',
  'chrome',
  'clerk',
  'code-bracket',
  'cog-6-teeth',
  'door',
  'elysia',
  'expressjs',
  'globe',
  'go',
  'home',
  'hono',
  'javascript',
  'koa',
  'link',
  'linkedin',
  'lock',
  'nextjs',
  'nodejs',
  'plug',
  'plus-circle',
  'python',
  'react',
  'redwood',
  'remix',
  'react-router',
  'rocket',
  'route',
  'ruby',
  'rust',
  'speedometer',
  'stacked-rectangle',
  'solid',
  'svelte',
  'tanstack',
  'user-circle',
  'user-dotted-circle',
  'vue',
  'x',
  'expo',
  'nuxt',
  'fastify',
])

type Icon = z.infer<typeof icon>

const tag = z.enum(['(Beta)', '(Community)'])

type Tag = z.infer<typeof tag>

type ManifestItem = {
  title: string
  href: string
  tag?: Tag
  wrap?: boolean
  icon?: Icon
  target?: '_blank'
  sdk?: SDK[]
}

type ManifestGroup = {
  title: string
  items: Manifest
  collapse?: boolean
  tag?: Tag
  wrap?: boolean
  icon?: Icon
  hideTitle?: boolean
  sdk?: SDK[]
}

type Manifest = (ManifestItem | ManifestGroup)[][]

// Create manifest schema based on config
const createManifestSchema = (config: BuildConfig) => {
  const manifestItem: z.ZodType<ManifestItem> = z
    .object({
      title: z.string(),
      href: z.string(),
      tag: tag.optional(),
      wrap: z.boolean().default(config.manifestOptions.wrapDefault),
      icon: icon.optional(),
      target: z.enum(['_blank']).optional(),
      sdk: z.array(sdk).optional(),
    })
    .strict()

  const manifestGroup: z.ZodType<ManifestGroup> = z
    .object({
      title: z.string(),
      items: z.lazy(() => manifestSchema),
      collapse: z.boolean().default(config.manifestOptions.collapseDefault),
      tag: tag.optional(),
      wrap: z.boolean().default(config.manifestOptions.wrapDefault),
      icon: icon.optional(),
      hideTitle: z.boolean().default(config.manifestOptions.hideTitleDefault),
      sdk: z.array(sdk).optional(),
    })
    .strict()

  const manifestSchema: z.ZodType<Manifest> = z.array(z.array(z.union([manifestItem, manifestGroup])))

  return {
    manifestItem,
    manifestGroup,
    manifestSchema,
  }
}

const pleaseReport = '(this is a bug with the build script, please report)'

const isValidSdk =
  (config: BuildConfig) =>
  (sdk: string): sdk is SDK => {
    return config.validSdks.includes(sdk as SDK)
  }

const isValidSdks =
  (config: BuildConfig) =>
  (sdks: string[]): sdks is SDK[] => {
    return sdks.every(isValidSdk(config))
  }

const readManifest = (config: BuildConfig) => async (): Promise<Manifest> => {
  const { manifestSchema } = createManifestSchema(config)
  const unsafe_manifest = await fs.readFile(config.manifestFilePath, { encoding: 'utf-8' })

  const manifest = await manifestSchema.safeParseAsync(JSON.parse(unsafe_manifest).navigation)

  if (manifest.success === true) {
    return manifest.data
  }

  throw new Error(`Failed to parse manifest: ${fromError(manifest.error)}`)
}

const readMarkdownFile = (config: BuildConfig) => async (docPath: string) => {
  const filePath = path.join(config.docsPath, docPath)

  try {
    const fileContent = await fs.readFile(filePath, { encoding: 'utf-8' })
    return [null, fileContent] as const
  } catch (error) {
    return [new Error(`file ${filePath} doesn't exist`, { cause: error }), null] as const
  }
}

const readDocsFolder = (config: BuildConfig) => async () => {
  return readdirp.promise(config.docsPath, {
    type: 'files',
    fileFilter: (entry) =>
      config.ignorePaths.some((ignoreItem) => `/docs/${entry.path}`.startsWith(ignoreItem)) === false &&
      entry.path.endsWith('.mdx'),
  })
}

const readPartialsFolder = (config: BuildConfig) => async () => {
  return readdirp.promise(config.partialsPath, {
    type: 'files',
    fileFilter: '*.mdx',
  })
}

const readPartial = (config: BuildConfig) => async (filePath: string) => {
  const readFile = readMarkdownFile(config)

  const fullPath = path.join(config.docsRelativePath, config.partialsRelativePath, filePath)

  const [error, content] = await readFile(fullPath)

  if (error) {
    throw new Error(`Failed to read in ${fullPath} from partials file`, { cause: error })
  }

  let partialNode: Node | null = null

  const partialContentVFile = await markdownProcessor()
    .use(() => (tree) => {
      partialNode = tree
    })
    .use(() => (tree, vfile) => {
      mdastVisit(
        tree,
        (node) =>
          (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
          'name' in node &&
          node.name === 'Include',
        (node) => {
          vfile.fail(`Partials inside of partials is not yet supported, ${pleaseReport}`, node.position)
        },
      )
    })
    .process({
      path: `docs/_partials/${filePath}`,
      value: content,
    })

  const partialContentReport = reporter([partialContentVFile], { quiet: true })

  if (partialContentReport !== '') {
    console.error(partialContentReport)
    process.exit(1)
  }

  if (partialNode === null) {
    throw new Error(`Failed to parse the content of ${filePath}`)
  }

  return {
    path: filePath,
    content,
    vfile: partialContentVFile,
    node: partialNode as Node,
  }
}

const readPartialsMarkdown =
  (config: BuildConfig, store: ReturnType<typeof createBlankStore>) => async (paths: string[]) => {
    const read = readPartial(config)

    return Promise.all(
      paths.map(async (markdownPath) => {
        const cachedValue = store.partialsFiles.get(markdownPath)

        if (cachedValue !== undefined) {
          return cachedValue
        }

        const partial = await read(markdownPath)

        store.partialsFiles.set(markdownPath, partial)

        return partial
      }),
    )
  }

const markdownProcessor = remark().use(remarkFrontmatter).use(remarkMdx).freeze()

type VFile = Awaited<ReturnType<typeof markdownProcessor.process>>

const ensureDirectory =
  (config: BuildConfig) =>
  async (dirPath: string): Promise<void> => {
    try {
      await fs.access(dirPath)
    } catch {
      await fs.mkdir(dirPath, { recursive: true })
    }
  }

const writeDistFile = (config: BuildConfig) => async (filePath: string, contents: string) => {
  const ensureDir = ensureDirectory(config)
  const fullPath = path.join(config.distPath, filePath)
  await ensureDir(path.dirname(fullPath))
  await fs.writeFile(fullPath, contents, { encoding: 'utf-8' })
}

const writeSDKFile = (config: BuildConfig) => async (sdk: SDK, filePath: string, contents: string) => {
  const writeFile = writeDistFile(config)
  await writeFile(path.join(sdk, filePath), contents)
}

const removeMdxSuffix = (filePath: string) => {
  if (filePath.includes('#')) {
    const [url, hash] = filePath.split('#')

    if (url.endsWith('.mdx')) {
      return url.slice(0, -4) + `#${hash}`
    }

    return url + `#${hash}`
  }

  if (filePath.endsWith('.mdx')) {
    return filePath.slice(0, -4)
  }

  return filePath
}

type BlankTree<Item extends object, Group extends { items: BlankTree<Item, Group> }> = Array<Array<Item | Group>>

const traverseTree = async <
  Tree extends { items: BlankTree<any, any> },
  InItem extends Extract<Tree['items'][number][number], { href: string }>,
  InGroup extends Extract<Tree['items'][number][number], { items: BlankTree<InItem, InGroup> }>,
  OutItem extends { href: string },
  OutGroup extends { items: BlankTree<OutItem, OutGroup> },
  OutTree extends BlankTree<OutItem, OutGroup>,
>(
  tree: Tree,
  itemCallback: (item: InItem, tree: Tree) => Promise<OutItem | null> = async (item) => item,
  groupCallback: (group: InGroup, tree: Tree) => Promise<OutGroup | null> = async (group) => group,
  errorCallback?: (item: InItem | InGroup, error: Error) => void | Promise<void>,
): Promise<OutTree> => {
  const result = await Promise.all(
    tree.items.map(async (group) => {
      return await Promise.all(
        group.map(async (item) => {
          try {
            if ('href' in item) {
              return await itemCallback(item, tree)
            }

            if ('items' in item && Array.isArray(item.items)) {
              const newGroup = await groupCallback(item, tree)

              if (newGroup === null) return null

              // @ts-expect-error - OutGroup should always contain "items" property, so this is safe
              const newItems = (await traverseTree(newGroup, itemCallback, groupCallback, errorCallback)).map((group) =>
                group.filter((item): item is NonNullable<typeof item> => item !== null),
              )

              return {
                ...newGroup,
                items: newItems,
              }
            }

            return item as OutItem
          } catch (error) {
            if (error instanceof Error && errorCallback !== undefined) {
              errorCallback(item, error)
            } else {
              throw error
            }
          }
        }),
      )
    }),
  )

  return result.map((group) =>
    group.filter((item): item is NonNullable<typeof item> => item !== null),
  ) as unknown as OutTree
}

function flattenTree<
  Tree extends BlankTree<any, any>,
  InItem extends Extract<Tree[number][number], { href: string }>,
  InGroup extends Extract<Tree[number][number], { items: BlankTree<InItem, InGroup> }>,
>(tree: Tree): InItem[] {
  const result: InItem[] = []

  for (const group of tree) {
    for (const itemOrGroup of group) {
      if ('href' in itemOrGroup) {
        // It's an item
        result.push(itemOrGroup)
      } else if ('items' in itemOrGroup && Array.isArray(itemOrGroup.items)) {
        // It's a group with its own sub-tree, flatten it
        result.push(...flattenTree(itemOrGroup.items))
      }
    }
  }

  return result
}

const scopeHrefToSDK = (href: string, targetSDK: SDK | ':sdk:') => {
  // This is external so can't change it
  if (href.startsWith('/docs') === false) return href

  const hrefSegments = href.split('/')

  // This is a little hacky so we might change it
  // if the url already contains the sdk, we don't need to change it
  if (hrefSegments.includes(targetSDK)) {
    return href
  }

  // Add the sdk to the url
  return `/docs/${targetSDK}/${hrefSegments.slice(2).join('/')}`
}

const extractComponentPropValueFromNode = (
  node: Node,
  vfile: VFile | undefined,
  componentName: string,
  propName: string,
  required = true,
): string | undefined => {
  // Check if it's an MDX component
  if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') {
    return undefined
  }

  // Check if it's the correct component
  if (!('name' in node)) return undefined
  if (node.name !== componentName) return undefined

  // Check for attributes
  if (!('attributes' in node)) {
    vfile?.message(`<${componentName} /> component has no props`, node.position)
    return undefined
  }

  if (!Array.isArray(node.attributes)) {
    vfile?.message(`<${componentName} /> node attributes is not an array ${pleaseReport}`, node.position)
    return undefined
  }

  // Find the requested prop
  const propAttribute = node.attributes.find((attribute) => attribute.name === propName)

  if (propAttribute === undefined) {
    if (required === true) {
      vfile?.message(`<${componentName} /> component has no "${propName}" attribute`, node.position)
    }
    return undefined
  }

  const value = propAttribute.value

  if (value === undefined) {
    if (required === true) {
      vfile?.message(`<${componentName} /> attribute "${propName}" has no value ${pleaseReport}`, node.position)
    }
    return undefined
  }

  // Handle both string values and object values (like JSX expressions)
  if (typeof value === 'string') {
    return value
  } else if (typeof value === 'object' && 'value' in value) {
    return value.value
  }

  vfile?.message(`<${componentName} /> attribute "${propName}" has an unsupported value type`, node.position)
  return undefined
}

const extractSDKsFromIfProp = (config: BuildConfig) => (node: Node, vfile: VFile | undefined, sdkProp: string) => {
  const isValidItem = isValidSdk(config)
  const isValidItems = isValidSdks(config)

  if (sdkProp.includes('", "') || sdkProp.includes("', '") || sdkProp.includes('["') || sdkProp.includes('"]')) {
    const sdks = JSON.parse(sdkProp.replaceAll("'", '"')) as string[]
    if (isValidItems(sdks)) {
      return sdks
    } else {
      const invalidSDKs = sdks.filter((sdk) => !isValidItem(sdk))
      vfile?.message(`sdks "${invalidSDKs.join('", "')}" in <If /> are not valid SDKs`, node.position)
    }
  } else {
    if (isValidItem(sdkProp)) {
      return [sdkProp]
    } else {
      vfile?.message(`sdk "${sdkProp}" in <If /> is not a valid SDK`, node.position)
    }
  }
}

const parseInMarkdownFile =
  (config: BuildConfig) =>
  async (href: string, partials: { path: string; content: string; node: Node }[], inManifest: boolean) => {
    const readFile = readMarkdownFile(config)
    const [error, fileContent] = await readFile(`${href}.mdx`.replace('/docs/', ''))

    if (error !== null) {
      throw new Error(`Attempting to read in ${href}.mdx failed, with error message: ${error.message}`, {
        cause: error,
      })
    }

    type Frontmatter = {
      title: string
      description?: string
      sdk?: SDK[]
    }

    let frontmatter: Frontmatter | undefined = undefined

    const slugify = slugifyWithCounter()
    const headingsHashs: Array<string> = []

    const vfile = await markdownProcessor()
      // Some validation
      .use(() => (tree, vfile) => {
        if (inManifest === false) {
          vfile.message(
            'This doc is not in the manifest.json, but will still be publicly accessible and other docs can link to it',
          )
        }

        if (href !== encodeURI(href)) {
          vfile.fail(`Href "${href}" contains characters that will be encoded by the browser, please remove them`)
        }
      })
      // Pull out the frontmatter
      .use(() => (tree, vfile) => {
        mdastVisit(
          tree,
          (node) => node.type === 'yaml' && 'value' in node,
          (node) => {
            if (!('value' in node)) return
            if (typeof node.value !== 'string') return

            const frontmatterYaml: Record<'title' | 'description' | 'sdk', string | undefined> = yaml.parse(node.value)

            const frontmatterSDKs = frontmatterYaml.sdk?.split(', ')

            if (frontmatterSDKs !== undefined && isValidSdks(config)(frontmatterSDKs) === false) {
              const invalidSDKs = frontmatterSDKs.filter((sdk) => isValidSdk(config)(sdk) === false)
              vfile.fail(
                `Invalid SDK ${JSON.stringify(invalidSDKs)}, the valid SDKs are ${JSON.stringify(config.validSdks)}`,
                node.position,
              )
              return
            }

            if (frontmatterYaml.title === undefined) {
              vfile.fail(`Frontmatter must have a "title" property`, node.position)
              return
            }

            if (frontmatterYaml.description === undefined) {
              vfile.message(`Frontmatter should have a "description" property`, node.position)
            }

            frontmatter = {
              title: frontmatterYaml.title,
              description: frontmatterYaml.description,
              sdk: frontmatterSDKs,
            }
          },
        )

        if (frontmatter === undefined) {
          vfile.fail(`Frontmatter parsing failed for ${href}`)
          return
        }
      })
      // Validate the <Include />
      .use(() => (tree, vfile) => {
        return mdastVisit(tree, (node) => {
          const partialSrc = extractComponentPropValueFromNode(node, vfile, 'Include', 'src')

          if (partialSrc === undefined) return

          if (partialSrc.startsWith('_partials/') === false) {
            vfile.message(`<Include /> prop "src" must start with "_partials/"`, node.position)
            return
          }

          const partial = partials.find(
            (partial) => `_partials/${partial.path}` === `${removeMdxSuffix(partialSrc)}.mdx`,
          )

          if (partial === undefined) {
            vfile.message(`Partial /docs/${removeMdxSuffix(partialSrc)}.mdx not found`, node.position)
            return
          }
        })
      })
      // extract out the headings to check hashes in links
      .use(() => (tree) => {
        mdastVisit(
          tree,
          (node) => node.type === 'heading',
          (node) => {
            // @ts-expect-error - If the heading has a id in it, this will pick it up
            // eg # test {{ id: 'my-heading' }}
            // This is for remapping the hash to the custom id
            const id = node?.children
              ?.find((child) => child?.type === 'mdxTextExpression')
              ?.data?.estree?.body?.find((child) => child?.type === 'ExpressionStatement')
              ?.expression?.properties?.find((prop) => prop?.key?.name === 'id')?.value?.value as string | undefined

            if (id !== undefined) {
              headingsHashs.push(id)
            } else {
              const slug = slugify(toString(node).trim())
              headingsHashs.push(slug)
            }
          },
        )
      })
      .process({
        path: `${href.substring(1)}.mdx`,
        value: fileContent,
      })

    if (frontmatter === undefined) {
      throw new Error(`Frontmatter parsing failed for ${href}`)
    }

    return {
      href,
      sdk: (frontmatter as Frontmatter).sdk,
      vfile,
      headingsHashs,
      frontmatter: frontmatter as Frontmatter,
    }
  }

export const createBlankStore = () => ({
  markdownFiles: new Map<string, Awaited<ReturnType<ReturnType<typeof parseInMarkdownFile>>>>(),
  partialsFiles: new Map<string, Awaited<ReturnType<ReturnType<typeof readPartial>>>>(),
})

export const build = async (store: ReturnType<typeof createBlankStore>, config: BuildConfig) => {
  // Apply currying to create functions pre-configured with config
  const ensureDir = ensureDirectory(config)
  const getManifest = readManifest(config)
  const getDocsFolder = readDocsFolder(config)
  const getPartialsFolder = readPartialsFolder(config)
  const getPartialsMarkdown = readPartialsMarkdown(config, store)
  const parseMarkdownFile = parseInMarkdownFile(config)
  const writeFile = writeDistFile(config)
  const writeSdkFile = writeSDKFile(config)

  await ensureDir(config.distPath)

  const userManifest = await getManifest()
  console.info('✔️ Read Manifest')

  const docsFiles = await getDocsFolder()
  console.info('✔️ Read Docs Folder')

  const partials = await getPartialsMarkdown((await getPartialsFolder()).map((item) => item.path))
  console.info(`✔️ Read ${partials.length} Partials`)

  const docsMap = new Map<string, Awaited<ReturnType<typeof parseMarkdownFile>>>()
  const docsInManifest = new Set<string>()

  // Grab all the docs links in the manifest
  await traverseTree({ items: userManifest }, async (item) => {
    if (!item.href?.startsWith('/docs/')) return item
    if (item.target !== undefined) return item

    const ignore = config.ignorePaths.some((ignoreItem) => item.href.startsWith(ignoreItem))
    if (ignore === true) return item

    docsInManifest.add(item.href)

    return item
  })
  console.info('✔️ Parsed in Manifest')

  // Read in all the docs
  const docsArray = await Promise.all(
    docsFiles.map(async (file) => {
      const href = removeMdxSuffix(`/docs/${file.path}`)

      const inManifest = docsInManifest.has(href)

      let markdownFile: Awaited<ReturnType<typeof parseMarkdownFile>>

      const cachedMarkdownFile = store.markdownFiles.get(href)

      if (cachedMarkdownFile) {
        markdownFile = structuredClone(cachedMarkdownFile)
      } else {
        markdownFile = await parseMarkdownFile(href, partials, inManifest)

        store.markdownFiles.set(href, structuredClone(markdownFile))
      }

      docsMap.set(href, markdownFile)

      return markdownFile
    }),
  )
  console.info(`✔️ Loaded in ${docsArray.length} docs`)

  // Goes through and grabs the sdk scoping out of the manifest
  const sdkScopedManifest = await traverseTree(
    { items: userManifest, sdk: undefined as undefined | SDK[] },
    async (item, tree) => {
      if (!item.href?.startsWith('/docs/')) return item
      if (item.target !== undefined) return item

      const ignore = config.ignorePaths.some((ignoreItem) => item.href.startsWith(ignoreItem))
      if (ignore === true) return item // even thou we are not processing them, we still need to keep them

      const doc = docsMap.get(item.href)

      if (doc === undefined) {
        throw new Error(`Doc "${item.title}" in manifest.json not found in the docs folder at ${item.href}.mdx`)
      }

      // This is the sdk of the doc as defined in the docs frontmatter
      const docSDK = doc.sdk

      // This is the sdk of the parent group
      const parentSDK = tree.sdk

      // either use the defined sdk of the doc, or the parent group
      const sdk = docSDK ?? parentSDK

      if (docSDK !== undefined && parentSDK !== undefined) {
        if (docSDK.every((sdk) => parentSDK?.includes(sdk)) === false) {
          throw new Error(
            `Doc "${item.title}" is attempting to use ${JSON.stringify(docSDK)} But its being filtered down to ${JSON.stringify(parentSDK)} in the manifest.json`,
          )
        }
      }

      return {
        ...item,
        sdk,
      }
    },
    async ({ items, ...details }, tree) => {
      // This takes all the children items, grabs the sdks out of them, and combines that in to a list
      const groupsItemsCombinedSDKs = (() => {
        const sdks = items?.flatMap((item) => item.flatMap((item) => item.sdk))

        if (sdks === undefined) return []

        return Array.from(new Set(sdks)).filter((sdk): sdk is SDK => sdk !== undefined)
      })()

      // This is the sdk of the group as defined in the manifest.json
      const groupSDK = details.sdk

      // This is the sdk of the parent group
      const parentSDK = tree.sdk

      if (groupSDK !== undefined && parentSDK !== undefined) {
        if (groupSDK.every((sdk) => parentSDK?.includes(sdk)) === false) {
          throw new Error(
            `Group "${details.title}" is attempting to use ${JSON.stringify(groupSDK)} But its being filtered down to ${JSON.stringify(parentSDK)} in the manifest.json`,
          )
        }
      }

      // If there are no children items, then the we either use the group we are looking at sdks if its defined, or its parent group
      if (groupsItemsCombinedSDKs.length === 0) {
        return { ...details, sdk: groupSDK ?? parentSDK, items } as ManifestGroup
      }

      if (groupSDK !== undefined && groupSDK.length > 0) {
        return {
          ...details,
          sdk: groupSDK,
          items,
        } as ManifestGroup
      }

      return {
        ...details,
        // If there are children items, then we combine the sdks of the group and the children items sdks
        sdk: Array.from(new Set([...(groupSDK ?? []), ...groupsItemsCombinedSDKs])) ?? [],
        items,
      } as ManifestGroup
    },
    (item, error) => {
      console.error('↳', item.title)
      throw error
    },
  )
  console.info('✔️ Applied manifest sdk scoping')

  await writeFile(
    'manifest.json',
    JSON.stringify({
      navigation: await traverseTree(
        { items: sdkScopedManifest },
        async (item) => {
          return {
            title: item.title,
            href: docsMap.get(item.href)?.sdk !== undefined ? scopeHrefToSDK(item.href, ':sdk:') : item.href,
            tag: item.tag,
            wrap: item.wrap === config.manifestOptions.wrapDefault ? undefined : item.wrap,
            icon: item.icon,
            target: item.target,
            sdk: item.sdk,
          }
        },
        // @ts-expect-error - This traverseTree function might just be the death of me
        async (group) => {
          return {
            title: group.title,
            collapse: group.collapse === config.manifestOptions.collapseDefault ? undefined : group.collapse,
            tag: group.tag,
            wrap: group.wrap === config.manifestOptions.wrapDefault ? undefined : group.wrap,
            icon: group.icon,
            hideTitle: group.hideTitle === config.manifestOptions.hideTitleDefault ? undefined : group.hideTitle,
            sdk: group.sdk,
            items: group.items,
          }
        },
      ),
    }),
  )

  const flatSDKScopedManifest = flattenTree(sdkScopedManifest)

  const partialsVFiles = await Promise.all(
    partials.map(async (partial) => {
      return await markdownProcessor()
        // validate links in partials to docs are valid and replace the links to sdk scoped pages with the sdk link component
        .use(() => (tree, vfile) => {
          return mdastMap(tree, (node) => {
            if (node.type !== 'link') return node
            if (!('url' in node)) return node
            if (typeof node.url !== 'string') return node
            if (!node.url.startsWith('/docs/')) return node
            if (!('children' in node)) return node

            // we are overwriting the url with the mdx suffix removed
            node.url = removeMdxSuffix(node.url)

            const [url, hash] = (node.url as string).split('#')

            const ignore = config.ignorePaths.some((ignoreItem) => url.startsWith(ignoreItem))
            if (ignore === true) return node

            const doc = docsMap.get(url)

            if (doc === undefined) {
              vfile.message(`Doc ${url} not found`, node.position)
              return node
            }

            if (hash !== undefined) {
              const hasHash = doc.headingsHashs.includes(hash)

              if (hasHash === false) {
                vfile.message(`Hash "${hash}" not found in ${url}`, node.position)
              }
            }

            if (doc.sdk !== undefined) {
              // we are going to swap it for the sdk link component to give the users a great experience

              return mdastBuilder('mdxJsxTextElement', {
                name: 'SDKLink',
                attributes: [
                  mdastBuilder('mdxJsxAttribute', {
                    name: 'href',
                    value: scopeHrefToSDK(url, ':sdk:'),
                  }),
                  mdastBuilder('mdxJsxAttribute', {
                    name: 'sdks',
                    value: mdastBuilder('mdxJsxAttributeValueExpression', {
                      value: JSON.stringify(doc.sdk),
                    }),
                  }),
                ],
              })
            }

            return node
          })
        })
        .process(partial.vfile)
    }),
  )
  console.info(`✔️ Validated all partials`)

  const coreVFiles = await Promise.all(
    docsArray.map(async (doc) => {
      const vfile = await markdownProcessor()
        // embed the partials into the doc
        .use(() => (tree, vfile) => {
          return mdastMap(tree, (node) => {
            const partialSrc = extractComponentPropValueFromNode(node, vfile, 'Include', 'src')

            if (partialSrc === undefined) return node

            const partial = partials.find(
              (partial) => `_partials/${partial.path}` === `${removeMdxSuffix(partialSrc)}.mdx`,
            )

            if (partial === undefined) return node // a warning will have already been reported

            return Object.assign(node, partial.node)
          })
        })
        // Validate links between docs are valid and replace the links to sdk scoped pages with the sdk link component
        .use(() => (tree: Node, vfile: VFile) => {
          return mdastMap(tree, (node) => {
            if (node.type !== 'link') return node
            if (!('url' in node)) return node
            if (typeof node.url !== 'string') return node
            if (!node.url.startsWith('/docs/')) return node
            if (!('children' in node)) return node

            // we are overwriting the url with the mdx suffix removed
            node.url = removeMdxSuffix(node.url)

            const [url, hash] = (node.url as string).split('#')

            const ignore = config.ignorePaths.some((ignoreItem) => url.startsWith(ignoreItem))
            if (ignore === true) return node

            const doc = docsMap.get(url)

            if (doc === undefined) {
              vfile.message(`Doc ${url} not found`, node.position)
              return node
            }

            if (hash !== undefined) {
              const hasHash = doc.headingsHashs.includes(hash)

              if (hasHash === false) {
                vfile.message(`Hash "${hash}" not found in ${url}`, node.position)
              }
            }

            if (doc.sdk !== undefined) {
              // we are going to swap it for the sdk link component to give the users a great experience

              return mdastBuilder('mdxJsxTextElement', {
                name: 'SDKLink',
                attributes: [
                  mdastBuilder('mdxJsxAttribute', {
                    name: 'href',
                    value: scopeHrefToSDK(url, ':sdk:'),
                  }),
                  mdastBuilder('mdxJsxAttribute', {
                    name: 'sdks',
                    value: mdastBuilder('mdxJsxAttributeValueExpression', {
                      value: JSON.stringify(doc.sdk),
                    }),
                  }),
                ],
              })
            }

            return node
          })
        })
        // Validate the <If /> components
        .use(() => (tree, vfile) => {
          mdastVisit(tree, (node) => {
            const sdk = extractComponentPropValueFromNode(node, vfile, 'If', 'sdk', false)

            if (sdk === undefined) return

            const sdksFilter = extractSDKsFromIfProp(config)(node, vfile, sdk)

            if (sdksFilter === undefined) return

            const manifestItems = flatSDKScopedManifest.filter((item) => item.href === doc.href)

            const availableSDKs = manifestItems.flatMap((item) => item.sdk).filter(Boolean)

            // The doc doesn't exist in the manifest so we are skipping it
            if (manifestItems.length === 0) return

            sdksFilter.forEach((sdk) => {
              ;(() => {
                if (doc.sdk === undefined) return

                const available = doc.sdk.includes(sdk)

                if (available === false) {
                  vfile.fail(
                    `<If /> component is attempting to filter to sdk "${sdk}" but it is not available in the docs frontmatter ["${doc.sdk.join('", "')}"], if this is a mistake please remove it from the <If /> otherwise update the frontmatter to include "${sdk}"`,
                    node.position,
                  )
                }
              })()
              ;(() => {
                // The doc is generic so we are skipping it
                if (availableSDKs.length === 0) return

                const available = availableSDKs.includes(sdk)

                if (available === false) {
                  vfile.fail(
                    `<If /> component is attempting to filter to sdk "${sdk}" but it is not available in the manifest.json for ${doc.href}, if this is a mistake please remove it from the <If /> otherwise update the manifest.json to include "${sdk}"`,
                    node.position,
                  )
                }
              })()
            })
          })
        })
        .process(doc.vfile)

      const distFilePath = `${doc.href.replace('/docs/', '')}.mdx`

      if (isValidSdk(config)(distFilePath.split('/')[0])) {
        throw new Error(
          `Doc "${doc.href}" is attempting to write out a doc to ${distFilePath} but the first part of the path is a valid SDK, this causes a file path conflict.`,
        )
      }

      if (doc.sdk !== undefined) {
        // This is a sdk specific doc, so we want to put a landing page here to redirect the user to a doc customized to their sdk.

        await writeFile(
          distFilePath,
          // It's possible we will want to / need to put some frontmatter here
          `<SDKDocRedirectPage title="${doc.frontmatter.title}"${doc.frontmatter.description ? ` description="${doc.frontmatter.description}" ` : ' '}href="${scopeHrefToSDK(doc.href, ':sdk:')}" sdks={${JSON.stringify(doc.sdk)}} />`,
        )

        return vfile
      }

      await writeFile(distFilePath, String(vfile))

      return vfile
    }),
  )

  console.info(`✔️ Validated and wrote out all docs`)

  const sdkSpecificVFiles = await Promise.all(
    config.validSdks.map(async (targetSdk) => {
      const vFiles = await Promise.all(
        docsArray.map(async (doc) => {
          if (doc.sdk === undefined) return null // skip core docs
          if (doc.sdk.includes(targetSdk) === false) return null // skip docs that are not for the target sdk

          const vfile = await markdownProcessor()
            // filter out content that is only available to other sdk's
            .use(() => (tree, vfile) => {
              return mdastFilter(tree, (node) => {
                // We aren't passing the vfile here as the as the warning
                // should have already been reported above when we initially
                // parsed the file

                const sdk = extractComponentPropValueFromNode(node, undefined, 'If', 'sdk')

                if (sdk === undefined) return true

                const sdksFilter = extractSDKsFromIfProp(config)(node, undefined, sdk)

                if (sdksFilter === undefined) return true

                if (sdksFilter.includes(targetSdk)) {
                  return true
                }

                return false
              })
            })
            // scope urls so they point to the current sdk
            .use(() => (tree, vfile) => {
              return mdastMap(tree, (node) => {
                if (node.type !== 'link') return node
                if (!('url' in node)) {
                  vfile.fail(`Link node does not have a url property ${pleaseReport}`, node.position)
                  return node
                }
                if (typeof node.url !== 'string') {
                  vfile.fail(`Link node url must be a string ${pleaseReport}`, node.position)
                  return node
                }
                if (!node.url.startsWith('/docs/')) {
                  return node
                }

                // we are overwriting the url with the mdx suffix removed
                node.url = removeMdxSuffix(node.url)

                const [url, hash] = (node.url as string).split('#')

                const doc = docsMap.get(url)

                if (doc === undefined) {
                  vfile.fail(`(SDK Specific Docs) Doc ${url} not found`, node.position)
                  return node
                }

                // we might need to do something here with doc

                return node
              })
            })
            // Insert the canonical link into the doc frontmatter
            .use(() => (tree, vfile) => {
              return mdastMap(tree, (node) => {
                if (node.type !== 'yaml') return node
                if (!('value' in node)) return node
                if (typeof node.value !== 'string') return node

                const frontmatter = yaml.parse(node.value)

                frontmatter.canonical = doc.sdk ? scopeHrefToSDK(doc.href, ':sdk:') : doc.href

                node.value = yaml.stringify(frontmatter).split('\n').slice(0, -1).join('\n')

                return node
              })
            })
            .process({
              ...doc.vfile,
              messages: [], // reset the messages, otherwise they will be duplicated
            })

          await writeSdkFile(targetSdk, `${doc.href.replace('/docs/', '')}.mdx`, String(vfile))

          return vfile
        }),
      )

      return { targetSdk, vFiles }
    }),
  )

  sdkSpecificVFiles.forEach(({ targetSdk, vFiles }) =>
    console.info(`✔️ Wrote out ${vFiles.filter(Boolean).length} ${targetSdk} specific docs`),
  )

  const flatSdkSpecificVFiles = sdkSpecificVFiles
    .flatMap(({ vFiles }) => vFiles)
    .filter((item): item is NonNullable<typeof item> => item !== null)

  return reporter([...coreVFiles, ...partialsVFiles, ...flatSdkSpecificVFiles], { quiet: true })
}

const watchAndRebuild = (store: ReturnType<typeof createBlankStore>, config: BuildConfig) => {
  watcher.subscribe(config.docsPath, async (error, events) => {
    if (error !== null) {
      console.error(error)
      return
    }

    events.forEach((event) => {
      store.markdownFiles.delete(removeMdxSuffix(`/docs/${path.relative(config.docsPath, event.path)}`))
      store.partialsFiles.delete(path.relative(config.partialsPath, event.path))
    })

    const now = performance.now()

    const output = await build(store, config)

    const after = performance.now()

    console.log(`Rebuilt docs in ${after - now} milliseconds`)

    if (output !== '') {
      console.info(output)
    }
  })
}

type BuildConfigOptions = {
  basePath: string
  validSdks: readonly SDK[]
  docsPath: string
  manifestPath: string
  partialsPath: string
  distPath: string
  ignorePaths: string[]
  manifestOptions: {
    wrapDefault: boolean
    collapseDefault: boolean
    hideTitleDefault: boolean
  }
}

type BuildConfig = ReturnType<typeof createConfig>

// Takes the basePath and resolves the relative paths to be absolute paths
export function createConfig(config: BuildConfigOptions) {
  const resolve = (relativePath: string) => {
    return path.isAbsolute(relativePath) ? relativePath : path.join(config.basePath, relativePath)
  }

  return {
    basePath: config.basePath,
    validSdks: config.validSdks,

    manifestRelativePath: config.manifestPath,
    manifestFilePath: resolve(config.manifestPath),

    partialsRelativePath: config.partialsPath,
    partialsPath: resolve(config.partialsPath),

    docsRelativePath: config.docsPath,
    docsPath: resolve(config.docsPath),

    distRelativePath: config.distPath,
    distPath: resolve(config.distPath),

    ignorePaths: config.ignorePaths,
    manifestOptions: config.manifestOptions ?? {
      wrapDefault: true,
      collapseDefault: false,
      hideTitleDefault: false,
    },
  }
}

const main = async () => {
  const config = createConfig({
    basePath: __dirname,
    docsPath: '../docs',
    manifestPath: '../docs/manifest.json',
    partialsPath: '../docs/_partials',
    distPath: '../dist',
    ignorePaths: [
      '/docs/core-1',
      '/pricing',
      '/docs/reference/backend-api',
      '/docs/reference/frontend-api',
      '/support',
      '/discord',
      '/contact',
      '/contact/sales',
      '/contact/support',
      '/blog',
      '/changelog/2024-04-19',
      '/docs/_partials',
    ],
    validSdks: VALID_SDKS,
    manifestOptions: {
      wrapDefault: true,
      collapseDefault: false,
      hideTitleDefault: false,
    },
  })

  const store = createBlankStore()

  const output = await build(store, config)

  if (output !== '') {
    console.info(output)
  }

  const args = process.argv.slice(2)
  const watchFlag = args.includes('--watch')

  if (watchFlag) {
    console.info(`Watching for changes...`)

    watchAndRebuild(store, config)
  } else if (output !== '') {
    process.exit(1)
  }
}

// Only invokes the main function if we run the script directly eg npm run build, bun run ./scripts/build-docs.ts
if (require.main === module) {
  main()
}
