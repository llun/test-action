// @ts-check
/**
 * @typedef {{
 *  feedsContentPath: string
 *  categoryDataPath: string
 *  embeddedDataPath: string
 *  sitesDataPath: string
 *  entriesDataPath: string
 *  dataPath: string
 *  readabilityCachePath: string
 *  repositoryDataPath: string
 * }} Paths
 * @typedef {{
 *  repository: string
 * }} RepositoryData
 * @typedef {{
 *  name: string
 *  sites: SiteData[]
 * }} CategoryData
 * @typedef {{
 *  title: string
 *  link: string
 *  date: number
 *  author: string
 *  category: string
 *  entryHash: string
 *  siteHash: string
 *  siteTitle: string
 * }} SiteEntryData
 * @typedef {{
 *  title: string
 *  link: string
 *  updatedAt: number
 *  siteHash: string
 * }} SiteData
 * @typedef {SiteData & {
 *  entries: SiteEntryData[]
 * }} SiteDataWithEntries
 * @typedef {import('../feeds/parsers').Entry & {
 *  siteTitle: string
 *  siteHash: string
 *  entryHash: string
 *  category: string
 * }} EntryData
 */
const path = require('path')
const fs = require('fs')
const htmlmin = require('html-minifier')
const core = require('@actions/core')
const crypto = require('crypto')
const { getGithubActionPath } = require('../repository')
const { loadContent, close } = require('../puppeteer')

const GITHUB_ACTION_PATH = getGithubActionPath()
const FEEDS_CONTENT_PATH = path.join(
  process.env['GITHUB_WORKSPACE'] || '',
  'contents'
)
const EMBEDDED_DATA_PATH = path.join(
  (process.env['GITHUB_WORKSPACE'] && GITHUB_ACTION_PATH) || '',
  'pages',
  '_data'
)
const DATA_PATH = path.join(
  (process.env['GITHUB_WORKSPACE'] && GITHUB_ACTION_PATH) || '',
  'pages',
  'data'
)
const CATEGORY_DATA_PATH = path.join(DATA_PATH, 'categories')
const SITES_DATA_PATH = path.join(DATA_PATH, 'sites')
const ENTRIES_DATA_PATH = path.join(DATA_PATH, 'entries')
const READABILITY_CACHE_PATH = path.join(DATA_PATH, 'readability')
const WORKSPACE_READABILITY_CACHE_PATH = path.join(
  process.env['GITHUB_WORKSPACE'] || '_site',
  'data',
  'readability'
)
const REPOSITORY_DATA_PATH = path.join(EMBEDDED_DATA_PATH, 'github.json')
exports.REPOSITORY_DATA_PATH = REPOSITORY_DATA_PATH

/**
 *
 * @param {Paths} paths
 */
function prepareDirectories(paths) {
  const {
    feedsContentPath,
    embeddedDataPath,
    categoryDataPath,
    sitesDataPath,
    entriesDataPath,
    readabilityCachePath
  } = paths
  fs.statSync(feedsContentPath)
  fs.mkdirSync(embeddedDataPath, { recursive: true })
  fs.mkdirSync(categoryDataPath, { recursive: true })
  fs.mkdirSync(sitesDataPath, { recursive: true })
  fs.mkdirSync(entriesDataPath, { recursive: true })
  fs.mkdirSync(readabilityCachePath, { recursive: true })
}
exports.prepareDirectories = prepareDirectories

/**
 *
 * @param {string} input
 * @returns {string}
 */
function createHash(input) {
  const hash = crypto.createHash('sha256')
  hash.update(input)
  return hash.digest('hex')
}
exports.createHash = createHash

/**
 * Create repository eleventy variable
 *
 * @param {Paths} paths
 * @param {string} githubRootName
 * @param {string} customDomainName
 *
 * @returns {RepositoryData}
 */
function createRepositoryData(paths, githubRootName, customDomainName) {
  const { repositoryDataPath } = paths
  const isCustomDomainEnabled = !!customDomainName
  /**
   * @type {RepositoryData}
   */
  const data = {
    repository:
      (!isCustomDomainEnabled &&
        githubRootName.split('/').length > 1 &&
        `/${githubRootName.split('/')[1]}`) ||
      ''
  }
  fs.writeFileSync(repositoryDataPath, JSON.stringify(data))
  return data
}
exports.createRepositoryData = createRepositoryData

/**
 *
 * @param {Paths} paths
 * @param {string} category
 * @param {string} siteTitle
 * @param {string} siteHash
 * @param {import('../feeds/parsers').Entry} entry
 * @returns {EntryData}
 */
function createEntryData(paths, category, siteTitle, siteHash, entry) {
  const { entriesDataPath } = paths
  const entryHash = createHash(`${entry.title},${entry.link}`)
  /**
   * @type {EntryData}
   */
  const data = {
    ...entry,
    siteTitle,
    siteHash,
    entryHash,
    category
  }
  fs.writeFileSync(
    path.join(entriesDataPath, `${entryHash}.json`),
    JSON.stringify(data)
  )
  return data
}
exports.createEntryData = createEntryData

/**
 *
 * @param {Paths} paths
 * @param {string} category
 * @param {string[]} sites
 * @returns {SiteDataWithEntries[]}
 */
function createSitesData(paths, category, sites) {
  const { feedsContentPath, sitesDataPath } = paths
  /** @type {SiteDataWithEntries[]} */
  const result = []
  for (const site of sites) {
    const content = fs
      .readFileSync(path.join(feedsContentPath, category, site))
      .toString('utf8')
    /**
     * @type {import('../feeds/parsers').Site}
     */
    const json = JSON.parse(content)
    const siteHash = createHash(site.substring(0, site.length - '.json'.length))
    /**
     * @type {SiteDataWithEntries}
     */
    const data = {
      title: json.title,
      link: json.link,
      updatedAt: json.updatedAt,
      siteHash,
      entries: json.entries
        .map((entry) => {
          const entryData = createEntryData(
            paths,
            category,
            json.title,
            siteHash,
            entry
          )
          return {
            title: entryData.title,
            link: entryData.link,
            date: entryData.date,
            author: entryData.author,
            category,
            siteTitle: json.title,
            siteHash,
            entryHash: entryData.entryHash
          }
        })
        .sort((a, b) => b.date - a.date)
    }
    fs.writeFileSync(
      path.join(sitesDataPath, `${siteHash}.json`),
      JSON.stringify(data)
    )
    result.push(data)
  }
  return result
}

async function createAllEntriesData() {
  const entries = fs.readdirSync(ENTRIES_DATA_PATH)
  const entriesData = entries
    .map((entryHashFile) => {
      const entry = fs
        .readFileSync(path.join(ENTRIES_DATA_PATH, entryHashFile))
        .toString('utf8')
      /** @type {EntryData} */
      const json = JSON.parse(entry)
      /** @type {SiteEntryData} */
      const data = {
        title: json.title,
        link: json.link,
        date: json.date,
        author: json.author,
        siteTitle: json.siteTitle,
        siteHash: json.siteHash,
        entryHash: json.entryHash,
        category: json.category
      }
      return data
    })
    .sort((a, b) => b.date - a.date)
  const text = JSON.stringify(entriesData)
  fs.writeFileSync(path.join(DATA_PATH, 'all.json'), text)
}

async function loadEntryWithPuppeteer() {
  const entries = fs.readdirSync(ENTRIES_DATA_PATH)
  const cacheEntries = fs.readdirSync(WORKSPACE_READABILITY_CACHE_PATH)
  const previousSet = new Set(cacheEntries)
  for (const entry of entries) {
    previousSet.delete(entry)
  }
  console.log('Delete old caches', previousSet.size)
  for (const oldEntry of previousSet.values()) {
    fs.unlinkSync(path.join(WORKSPACE_READABILITY_CACHE_PATH, oldEntry))
  }
  for (const entryHashFile of entries) {
    const entryHash = entryHashFile.slice(
      0,
      entryHashFile.length - '.json'.length
    )
    const readabilityFile = path.join(
      READABILITY_CACHE_PATH,
      `${entryHash}.json`
    )
    try {
      fs.statSync(
        path.join(WORKSPACE_READABILITY_CACHE_PATH, `${entryHash}.json`)
      )
      console.log(`${entryHash} - Readability loaded, skip`)
      continue
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(error.message)
        continue
      }
    }
    const entry = fs
      .readFileSync(path.join(ENTRIES_DATA_PATH, entryHashFile))
      .toString('utf8')
    /** @type {EntryData} */
    const json = JSON.parse(entry)
    console.log(`${entryHash} - Load ${json.link}`)
    try {
      const content = await loadContent(json)
      if (!content) {
        console.log(`${entryHash} - Skip ${json.link}`)
        await close()
        continue
      }
      const minifyContent = htmlmin.minify(content, {
        useShortDoctype: true,
        removeComments: true,
        collapseWhitespace: true
      })
      /** @type {EntryData} */
      const entryData = {
        ...json,
        content: minifyContent
      }
      fs.writeFileSync(readabilityFile, JSON.stringify(entryData))
      await close()
    } catch (error) {
      console.log(`${entryHash} - Fail to load ${json.link}`)
      await close()
      continue
    }
  }
}

/**
 *
 * @param {Paths} paths
 */
async function createCategoryData(paths) {
  const { feedsContentPath, categoryDataPath, embeddedDataPath, dataPath } =
    paths
  const categories = fs.readdirSync(feedsContentPath)
  /** @type {CategoryData[]} */
  const categoriesData = []
  for (const category of categories) {
    const sites = fs.readdirSync(path.join(feedsContentPath, category))
    const sitesData = createSitesData(paths, category, sites)
    /** @type {CategoryData} */
    const categoryData = {
      name: category,
      sites: sitesData.map((data) => ({
        title: data.title,
        link: data.link,
        updatedAt: data.updatedAt,
        siteHash: data.siteHash
      }))
    }
    categoriesData.push(categoryData)

    const categoryEntries = sitesData.reduce(
      (entries, site) => [...entries, ...site.entries],
      /** @type {SiteEntryData[]} */ ([])
    )
    categoryEntries.sort((a, b) => b.date - a.date)
    fs.writeFileSync(
      path.join(categoryDataPath, `${category}.json`),
      JSON.stringify(categoryEntries)
    )
  }
  const text = JSON.stringify(categoriesData)
  fs.writeFileSync(path.join(embeddedDataPath, 'categories.json'), text)
  fs.writeFileSync(path.join(dataPath, 'categories.json'), text)
}
exports.createCategoryData = createCategoryData

async function prepareEleventyData() {
  try {
    console.log('Preparing eleventy data')
    const customDomainName = core.getInput('customDomain')
    const githubRootName = process.env['GITHUB_REPOSITORY'] || ''
    const paths = {
      feedsContentPath: FEEDS_CONTENT_PATH,
      categoryDataPath: CATEGORY_DATA_PATH,
      embeddedDataPath: EMBEDDED_DATA_PATH,
      sitesDataPath: SITES_DATA_PATH,
      entriesDataPath: ENTRIES_DATA_PATH,
      readabilityCachePath: READABILITY_CACHE_PATH,
      dataPath: DATA_PATH,
      repositoryDataPath: REPOSITORY_DATA_PATH
    }
    prepareDirectories(paths)
    createRepositoryData(paths, githubRootName, customDomainName)
    await createCategoryData(paths)
    await createAllEntriesData()
    await loadEntryWithPuppeteer()
  } catch (error) {
    if (error !== 'ENOENT') {
      core.setFailed(error)
      throw error
    }
  }
}
exports.prepareEleventyData = prepareEleventyData
