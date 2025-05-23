import fs from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { resolveId } from './resolve-id.mjs';

// return custom selectors from the css root, conditionally removing them
export default async function getCustomPropertiesFromRoot(root, resolver) {
	// initialize custom selectors
	let customProperties = {};

	// resolve current file directory
	let sourceDir = process.cwd();
	if (root.source && root.source.input && root.source.input.file) {
		sourceDir = path.dirname(root.source.input.file);
	}

	// recursively add custom properties from @import statements
	const importPromises = [];
	root.walkAtRules('import', atRule => {
		const promise = getImportPromise(atRule, resolver, sourceDir);
		if (promise) {
			importPromises.push(promise);
		}
	});

	root.walkAtRules('use', atRule => {
		const promise = getImportPromise(atRule, resolver, sourceDir);
		if (promise) {
			importPromises.push(promise);
		}
	});

	(await Promise.all(importPromises)).forEach(propertiesFromImport => {
		customProperties = Object.assign(customProperties, propertiesFromImport);
	});

	// for each custom property declaration
	root.walkDecls(decl => {
		if (!decl.variable || !decl.prop.startsWith('--')) {
			return;
		}

		// write the parsed value to the custom property
		customProperties[decl.prop] = decl.value;
	});

	// return all custom properties, preferring :root properties over html properties
	return customProperties;
}

async function getCustomPropertiesFromCSSFile(from, resolver) {
	try {
		const css = await fs.readFile(from, 'utf8');
		const root = postcss.parse(css, { from });

		return await getCustomPropertiesFromRoot(root, resolver);
	} catch (e) {
		return {};
	}
}

function parseImportParams(params) {
	const nodes = valueParser(params).nodes;
	if (!nodes.length) {
		return;
	}

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (node.type === 'space' || node.type === 'comment') {
			continue;
		}

		if (node.type === 'string') {
			return node.value;
		}

		if (node.type === 'function' && /url/i.test(node.value)) {
			for (let j = 0; j < node.nodes.length; j++) {
				const urlNode = node.nodes[j];
				if (urlNode.type === 'space' || urlNode.type === 'comment') {
					continue;
				}

				if (urlNode.type === 'word') {
					return urlNode.value;
				}

				if (urlNode.type === 'string') {
					return urlNode.value;
				}

				return false;
			}
		}

		return false;
	}

	return false;
}

function getFileNameFromAlias(fileName, resolver) {
	if (!resolver.alias) {
		return fileName;
	}

	const split = fileName.split('/');

	if (split.length > 0) {
		const resolvedAlias = Object.entries(resolver.alias).find(([key]) => key === split[0]);

		if (resolvedAlias) {
			const [alias, value] = resolvedAlias;
			return fileName.replace(alias, value);
		}
	}
	return fileName;
}

function getImportPromise(atRule, resolver, sourceDir) {
	const fileName = parseImportParams(atRule.params);
	if (!fileName) {
		return;
	}

	const aliasedFileName = getFileNameFromAlias(fileName, resolver);

	if (path.isAbsolute(fileName)) {
		return getCustomPropertiesFromCSSFile(aliasedFileName, resolver);
	} else {
		const promise = resolveId(aliasedFileName, sourceDir, {
			paths: resolver.paths,
			extensions: resolver.extensions,
			moduleDirectories: resolver.moduleDirectories,
		})
			.then((filePath) => getCustomPropertiesFromCSSFile(filePath, resolver))
			.catch(() => {});

		return promise;
	}
}