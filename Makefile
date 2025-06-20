dev:
	npm install

package: dev
	npx vsce package

publish:
	npx vsce publish
