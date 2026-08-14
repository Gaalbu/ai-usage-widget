package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.http.HttpClient;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;

public final class CollectorApp {
    private CollectorApp() {}

    public static void main(String[] args) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        Clock clock = Clock.systemDefaultZone();
        Map<String, String> environment = System.getenv();
        Path cache = cachePath(environment);
        HttpClient httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        CollectorService service = new CollectorService(
                mapper,
                clock,
                new CacheStore(mapper, cache),
                List.of(
                        new ClaudeProvider(mapper, httpClient, clock, environment),
                        new CodexProvider(mapper, clock, environment)));
        ObjectNode result = service.collectAll();
        boolean pretty = args.length == 1 && "--pretty".equals(args[0]);
        String output = pretty
                ? mapper.writerWithDefaultPrettyPrinter().writeValueAsString(result)
                : mapper.writeValueAsString(result);
        System.out.println(output);
    }

    private static Path cachePath(Map<String, String> environment) {
        String root = environment.get("XDG_CACHE_HOME");
        if (root == null || root.isBlank()) {
            root = Path.of(environment.getOrDefault("HOME", System.getProperty("user.home")), ".cache").toString();
        }
        return Path.of(root, "ai-usage-widget", "usage.json");
    }
}
