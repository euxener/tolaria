function additionLinesFor(additions, file) {
  if (additions.has(file)) return additions.get(file)
  const lines = new Set()
  lines.auditedRustUnsafeLines = new Set()
  additions.set(file, lines)
  return lines
}

function recordAddedLine(lines, lineNumber, source, previousAddedLine) {
  lines.add(lineNumber)
  const audited = previousAddedLine?.trimStart().startsWith('// SAFETY:')
    && source.includes('unsafe')
  if (audited) lines.auditedRustUnsafeLines.add(lineNumber)
}

export function addedLinesFromDiff(diff, repositoryRoot) {
  const additions = new Map()
  let file = null
  let nextLine = 0
  let previousAddedLine = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = `${repositoryRoot}/${line.slice(6)}`
      additionLinesFor(additions, file)
      previousAddedLine = null
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      nextLine = Number(hunk[1])
      continue
    }
    if (!file || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      const addedLine = line.slice(1)
      const lines = additions.get(file)
      recordAddedLine(lines, nextLine, addedLine, previousAddedLine)
      previousAddedLine = addedLine
      nextLine += 1
    } else if (!line.startsWith('-')) {
      previousAddedLine = null
      nextLine += 1
    }
  }
  return additions
}

export function biomeGateFailures(report, additions, repositoryRoot) {
  return (report.diagnostics ?? []).flatMap((diagnostic) => {
    const path = resolveDiagnosticPath(diagnostic.location?.path, repositoryRoot)
    const line = diagnostic.location?.start?.line
    if (!path || !line || !additions.get(path)?.has(line)) return []
    return [{
      line,
      message: diagnostic.message ?? 'Biome issue',
      path,
      rule: diagnostic.category ?? 'unknown rule',
      tool: 'Biome',
    }]
  })
}

export function eslintGateFailures(report, additions) {
  return report.flatMap(file => (file.messages ?? []).flatMap((message) => {
    if (!message.line || !additions.get(file.filePath)?.has(message.line)) return []
    return [{
      line: message.line,
      message: message.message ?? 'ESLint issue',
      path: file.filePath,
      rule: message.ruleId ?? 'unknown rule',
      tool: 'Codacy ESLint security rules',
    }]
  }))
}

function resolveDiagnosticPath(path, repositoryRoot) {
  if (!path) return ''
  return path.startsWith('/') ? path : `${repositoryRoot}/${path}`
}

function unquote(value) {
  const quote = value.charAt(0)
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1)
    return close === -1 ? value.slice(1) : value.slice(1, close)
  }
  const comment = value.indexOf(' #')
  return comment === -1 ? value : value.slice(0, comment).trim()
}

/** Reads `exclude_paths` from the root .codacy.yaml, the same list Codacy's hosted analysis skips. */
export function codacyExcludePatterns(yamlText) {
  const patterns = []
  let inExcludes = false
  for (const line of yamlText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-')) {
      inExcludes = trimmed === 'exclude_paths:'
      continue
    }
    if (inExcludes && trimmed.startsWith('- ')) patterns.push(unquote(trimmed.slice(2).trim()))
  }
  return patterns
}

function matchesSegment(pattern, name) {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === name
  const head = parts.shift()
  const tail = parts.pop()
  if (!name.startsWith(head) || !name.endsWith(tail) || name.length < head.length + tail.length) return false
  let cursor = head.length
  const end = name.length - tail.length
  for (const part of parts) {
    const found = name.indexOf(part, cursor)
    if (found === -1 || found + part.length > end) return false
    cursor = found + part.length
  }
  return true
}

function matchesSegments(patternSegments, pathSegments) {
  if (patternSegments.length === 0) return pathSegments.length === 0
  const [first, ...rest] = patternSegments
  if (first === '**') {
    for (let skip = 0; skip <= pathSegments.length; skip += 1) {
      if (matchesSegments(rest, pathSegments.slice(skip))) return true
    }
    return false
  }
  return pathSegments.length > 0 && matchesSegment(first, pathSegments[0]) && matchesSegments(rest, pathSegments.slice(1))
}

/** Codacy-style glob match on a repository-relative path: `**` spans directories, `*` stays inside one. */
export function matchesCodacyGlob(glob, relativePath) {
  return matchesSegments(glob.split('/'), relativePath.split('/'))
}

/** Drops files matching the Codacy exclude list so the local gate agrees with hosted Codacy. */
export function withoutExcludedPaths(additions, patterns, repositoryRoot) {
  const kept = new Map()
  for (const [file, lines] of additions) {
    const relative = file.startsWith(`${repositoryRoot}/`) ? file.slice(repositoryRoot.length + 1) : file
    if (!patterns.some((pattern) => matchesCodacyGlob(pattern, relative))) kept.set(file, lines)
  }
  return kept
}
