package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.util.List;

final class CollectorService {
    private final ObjectMapper mapper;
    private final Clock clock;
    private final CacheStore cacheStore;
    private final List<UsageProvider> providers;

    CollectorService(ObjectMapper mapper, Clock clock, CacheStore cacheStore, List<UsageProvider> providers) {
        this.mapper = mapper;
        this.clock = clock;
        this.cacheStore = cacheStore;
        this.providers = List.copyOf(providers);
    }

    ObjectNode collectAll() {
        ObjectNode cached = cacheStore.read();
        long now = clock.instant().getEpochSecond();
        ObjectNode providerResults = mapper.createObjectNode();
        ObjectNode cacheProviders = mapper.createObjectNode();

        for (UsageProvider provider : providers) {
            ObjectNode previous = cacheStore.freshProvider(cached, provider.name(), now);
            try {
                ObjectNode current = provider.collect();
                providerResults.set(provider.name(), current);
                cacheProviders.set(provider.name(), cacheEntry(now, current.path("windows")));
            } catch (ProviderException error) {
                providerResults.set(provider.name(), failure(error.getMessage(), error.configured(), previous));
                if (previous != null) {
                    cacheProviders.set(provider.name(), previous);
                }
            } catch (RuntimeException error) {
                providerResults.set(provider.name(), failure(
                        "Unexpected " + title(provider.name()) + " collector error", previous != null, previous));
                if (previous != null) {
                    cacheProviders.set(provider.name(), previous);
                }
            }
        }

        ObjectNode result = mapper.createObjectNode();
        result.put("version", 1);
        result.put("updatedAt", now);
        result.set("providers", providerResults);

        ObjectNode nextCache = mapper.createObjectNode();
        nextCache.put("version", 2);
        nextCache.set("providers", cacheProviders);
        cacheStore.write(nextCache);
        return result;
    }

    private ObjectNode failure(String message, boolean configured, ObjectNode previous) {
        ObjectNode result = mapper.createObjectNode();
        result.put("status", previous == null ? "error" : "stale");
        result.put("configured", configured || previous != null);
        result.put("message", message);
        result.set("windows", previous == null
                ? mapper.createArrayNode() : previous.path("windows").deepCopy());
        return result;
    }

    private ObjectNode cacheEntry(long now, JsonNode windows) {
        ObjectNode result = mapper.createObjectNode();
        result.put("cachedAt", now);
        result.set("windows", windows instanceof ArrayNode ? windows.deepCopy() : mapper.createArrayNode());
        return result;
    }

    private String title(String value) {
        return Character.toUpperCase(value.charAt(0)) + value.substring(1);
    }
}
