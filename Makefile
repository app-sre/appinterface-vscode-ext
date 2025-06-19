dev:
	npm install

package: dev
	vsce package

publish:
	vsce publish
