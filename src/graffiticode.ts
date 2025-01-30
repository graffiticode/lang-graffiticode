import { parser} from "@graffiticode/lezer-graffiticode"
import { SyntaxNode} from "@lezer/common"
import { LRLanguage, LanguageSupport, Sublanguage, sublanguageProp, defineLanguageFacet,
        delimitedIndent, flatIndent, continuedIndent, indentNodeProp,
        foldNodeProp, foldInside, syntaxTree } from "@codemirror/language"
import { EditorSelection, Text } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { completeFromList, ifNotIn } from "@codemirror/autocomplete"
import { snippets, typescriptSnippets } from "./snippets"
import { localCompletionSource, dontComplete } from "./complete"

/// A language provider based on the [Lezer JavaScript
/// parser](https://github.com/lezer-parser/javascript), extended with
/// highlighting and indentation information.
export const graffiticodeLanguage = LRLanguage.define({
  name: "graffiticode",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        JSXElement(context) {
          let closed = /^\s*<\//.test(context.textAfter)
          return context.lineIndent(context.node.from) + (closed ? 0 : context.unit)
        },
        JSXEscape(context) {
          let closed = /\s*\}/.test(context.textAfter)
          return context.lineIndent(context.node.from) + (closed ? 0 : context.unit)
        },
        "JSXOpenTag JSXSelfClosingTag"(context) {
          return context.column(context.node.from) + context.unit
        }
      }),
    ]
  }),
  languageData: {
    closeBrackets: {brackets: ["(", "[", "{", "'", '"', "`"]},
    commentTokens: {line: "//", block: {open: "/*", close: "*/"}},
    indentOnInput: /^\s*(?:case |default:|\{|\}|<\/)$/,
    wordChars: "$"
  }
})

const jsxSublanguage: Sublanguage = {
  test: node => /^JSX/.test(node.name),
  facet: defineLanguageFacet({commentTokens: {block: {open: "{/*", close: "*/}"}}})
}

/// A language provider for TypeScript.
export const typescriptLanguage = graffiticodeLanguage.configure({dialect: "ts"}, "typescript")

/// Language provider for JSX.
export const jsxLanguage = graffiticodeLanguage.configure({
  dialect: "jsx",
  props: [sublanguageProp.add(n => n.isTop ? [jsxSublanguage] : undefined)]
})

/// Language provider for JSX + TypeScript.
export const tsxLanguage = graffiticodeLanguage.configure({
  dialect: "jsx ts",
  props: [sublanguageProp.add(n => n.isTop ? [jsxSublanguage] : undefined)]
}, "typescript")

let kwCompletion = (name: string) => ({label: name, type: "keyword"})

const keywords = "break case const continue default delete export extends false finally in instanceof let new return static super switch this throw true typeof var yield".split(" ").map(kwCompletion)
const typescriptKeywords = keywords.concat(["declare", "implements", "private", "protected", "public"].map(kwCompletion))

/// Graffiticode support. Includes [snippet](#lang-graffiticode.snippets)
/// and local variable completion.
export function graffiticode() {
  const config = {jsx: false, typescript: false};
  let lang = config.jsx ? (config.typescript ? tsxLanguage : jsxLanguage)
    : config.typescript ? typescriptLanguage : graffiticodeLanguage
  let completions = config.typescript ? typescriptSnippets.concat(typescriptKeywords) : snippets.concat(keywords)
  return new LanguageSupport(lang, [
    graffiticodeLanguage.data.of({
      autocomplete: ifNotIn(dontComplete, completeFromList(completions))
    }),
    graffiticodeLanguage.data.of({
      autocomplete: localCompletionSource
    }),
    config.jsx ? autoCloseTags : [],
  ])
}

function findOpenTag(node: SyntaxNode) {
  for (;;) {
    if (node.name == "JSXOpenTag" || node.name == "JSXSelfClosingTag" || node.name == "JSXFragmentTag") return node
    if (node.name == "JSXEscape" || !node.parent) return null
    node = node.parent
  }
}

function elementName(doc: Text, tree: SyntaxNode | null | undefined, max = doc.length) {
  for (let ch = tree?.firstChild; ch; ch = ch.nextSibling) {
    if (ch.name == "JSXIdentifier" || ch.name == "JSXBuiltin" || ch.name == "JSXNamespacedName" ||
        ch.name == "JSXMemberExpression")
      return doc.sliceString(ch.from, Math.min(ch.to, max))
  }
  return ""
}

const android = typeof navigator == "object" && /Android\b/.test(navigator.userAgent)

/// Extension that will automatically insert JSX close tags when a `>` or
/// `/` is typed.
export const autoCloseTags = EditorView.inputHandler.of((view, from, to, text, defaultInsert) => {
  if ((android ? view.composing : view.compositionStarted) || view.state.readOnly ||
      from != to || (text != ">" && text != "/") ||
      !graffiticodeLanguage.isActiveAt(view.state, from, -1)) return false
  let base = defaultInsert(), {state} = base
  let closeTags = state.changeByRange(range => {
    let {head} = range, around = syntaxTree(state).resolveInner(head - 1, -1), name
    if (around.name == "JSXStartTag") around = around.parent!
    if (state.doc.sliceString(head - 1, head) != text || around.name == "JSXAttributeValue" && around.to > head) {
      // Ignore input inside attribute or cases where the text wasn't actually inserted
    } else if (text == ">" && around.name == "JSXFragmentTag") {
      return {range, changes: {from: head, insert: `</>`}}
    } else if (text == "/" && around.name == "JSXStartCloseTag") {
      let empty = around.parent!, base = empty.parent
      if (base && empty.from == head - 2 &&
          ((name = elementName(state.doc, base.firstChild, head)) || base.firstChild?.name == "JSXFragmentTag")) {
        let insert = `${name}>`
        return {range: EditorSelection.cursor(head + insert.length, -1), changes: {from: head, insert}}
      }
    } else if (text == ">") {
      let openTag = findOpenTag(around)
      if (openTag && openTag.name == "JSXOpenTag" &&
          !/^\/?>|^<\//.test(state.doc.sliceString(head, head + 2)) &&
          (name = elementName(state.doc, openTag, head)))
        return {range, changes: {from: head, insert: `</${name}>`}}
    }
    return {range}
  })
  if (closeTags.changes.empty) return false
  view.dispatch([
    base,
    state.update(closeTags, {userEvent: "input.complete", scrollIntoView: true})
  ])
  return true
});
