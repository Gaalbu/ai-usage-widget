UUID := ai-usage-widget@gaalbu.github.io
NATIVE := target/ai-usage-widget

.PHONY: test jar native package install uninstall clean

test:
	mvn test
	node --check $(UUID)/extension.js
	bash -n scripts/install.sh scripts/uninstall.sh scripts/package.sh

jar:
	mvn package

native:
	mvn -Pnative package

package: native
	./scripts/package.sh $(NATIVE)

install: native
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh

clean:
	mvn clean
	rm -rf build dist
