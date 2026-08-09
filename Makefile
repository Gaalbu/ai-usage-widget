UUID := ai-usage-widget@gaalbu.github.io

.PHONY: test package install uninstall

test:
	python3 -m unittest discover -s tests -v
	python3 -m py_compile $(UUID)/collector.py tests/test_collector.py
	node --check $(UUID)/extension.js
	bash -n scripts/install.sh scripts/uninstall.sh

package:
	gnome-extensions pack --force \
		--extra-source=collector.py \
		--extra-source=config.json \
		$(UUID)

install:
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh
