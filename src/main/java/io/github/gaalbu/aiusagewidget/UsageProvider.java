package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.node.ObjectNode;

interface UsageProvider {
    String name();

    ObjectNode collect() throws ProviderException;
}
