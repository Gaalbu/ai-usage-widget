package io.github.gaalbu.aiusagewidget;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class CacheStoreTest {
    private final ObjectMapper mapper = new ObjectMapper();
    @TempDir Path temporary;

    @Test
    void writerDoesNotFollowDestinationSymlinkAndKeepsCachePrivate() throws IOException {
        Path cache = temporary.resolve("cache/usage.json");
        Files.createDirectories(cache.getParent());
        Path target = temporary.resolve("target.json");
        Files.writeString(target, "do not overwrite");
        Files.createSymbolicLink(cache, target);

        ObjectNode payload = mapper.createObjectNode();
        payload.put("version", 2);
        payload.putObject("providers");
        new CacheStore(mapper, cache).write(payload);

        assertEquals("do not overwrite", Files.readString(target));
        assertFalse(Files.isSymbolicLink(cache));
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(cache)));
        assertEquals(2, new CacheStore(mapper, cache).read().path("version").asInt());
    }

    @Test
    void readerRejectsSymlinks() throws IOException {
        Path cache = temporary.resolve("cache/usage.json");
        Files.createDirectories(cache.getParent());
        Path target = temporary.resolve("target.json");
        Files.writeString(target, "{\"version\":2,\"providers\":{}}");
        Files.createSymbolicLink(cache, target);

        assertEquals(0, new CacheStore(mapper, cache).read().size());
        assertFalse(Files.isRegularFile(cache, LinkOption.NOFOLLOW_LINKS));
    }
}
